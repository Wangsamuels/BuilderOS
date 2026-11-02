import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env, type Logger } from "@builderos/shared";
import { and, approvalCards, encryptedLogs, eq, getDb, provenance, sql, tasks } from "@builderos/db";
import { createBuilderFetch, PurchasePending, PurchaseRejected } from "@builderos/fetch";
import { complete, MODELS, type Tier } from "@builderos/router";
import { seal, serialize, serverKey, sha256Hex } from "@builderos/crypto";
import { agentFor } from "./keystore.js";
import { ROLE_FOR_TAG } from "./planner.js";

const exec = promisify(execFile);
const ALWAYS_REVIEW = new Set(["contract", "security"]);

type FileOut = { path: string; content: string };

function parseFiles(text: string): FileOut[] {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[1]);
    return (j.files ?? []).filter((f: any) => typeof f.path === "string" && typeof f.content === "string");
  } catch {
    return [];
  }
}

function safeJoin(root: string, rel: string) {
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return p;
}

async function staticChecks(dir: string, files: FileOut[]) {
  const errors: string[] = [];
  for (const f of files) {
    const full = safeJoin(dir, f.path);
    if (/\.(m?js|cjs)$/.test(f.path)) {
      await exec(process.execPath, ["--check", full]).catch((e) => errors.push(`${f.path}: ${e.stderr?.toString().slice(0, 300)}`));
    } else if (f.path.endsWith(".json")) {
      try {
        JSON.parse(f.content);
      } catch (e: any) {
        errors.push(`${f.path}: ${e.message}`);
      }
    }
  }
  return errors;
}

/**
 * One task: route → model via @builderos/fetch → patch in an isolated workspace → tests → cross-lab review
 * → commit with provenance trailers → encrypted log + verdict.
 */
export async function runTask(taskId: string, log: Logger) {
  const db = getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || ["done", "running"].includes(t.status)) return;
  if (!t.departmentId) throw new Error(`task ${taskId} has no department`);
  const role = ROLE_FOR_TAG[t.tag] ?? "backend";
  const agent = await agentFor(t.departmentId, role);
  if (!agent) throw new Error(`no agent key for ${t.departmentId}/${role}`);

  await db.update(tasks).set({ status: "running", agent: agent.accountId, attempts: sql`${tasks.attempts} + 1`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  const bfetch = createBuilderFetch({ agent: { accountId: agent.accountId, privateKey: agent.privateKey } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `task-${taskId}-`));
  const transcript: string[] = [];

  try {
    // 1-2. Router picks the model; every call is a policy-checked purchase.
    const gen = await complete(
      {
        tag: t.tag,
        tier: t.tier as Tier,
        size: t.size,
        pinnedModel: t.pinnedModel,
        taskId,
        departmentId: t.departmentId,
        messages: [
          { role: "system", content: `You are the ${role} agent of an autonomous software company. Reply ONLY with \`\`\`json {"files":[{"path":"relative/path","content":"..."}],"summary":"..."}\`\`\`` },
          { role: "user", content: t.title },
        ],
      },
      { fetch: bfetch, log },
    );
    transcript.push(`gen:${gen.model}:${gen.text.slice(0, 4000)}`);

    // 3. Patch in an isolated workspace.
    const files = parseFiles(gen.text);
    if (!files.length) throw new Error("model returned no files");
    for (const f of files) {
      const full = safeJoin(dir, f.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content);
    }

    // 4. Tests (static checks locally; remote runners are paid sellers via MPP).
    const testErrors = await staticChecks(dir, files);
    transcript.push(`tests:${testErrors.length ? testErrors.join("\n") : "pass"}`);

    // 5. Review by a model from a different lab. Contract/security always reviewed.
    let reviewOk = testErrors.length === 0;
    if (reviewOk && (ALWAYS_REVIEW.has(t.tag) || t.tier !== "economy")) {
      const lab = MODELS.find((m) => m.id === gen.model)?.lab;
      const exclude = MODELS.filter((m) => m.lab === lab).map((m) => m.id);
      const review = await complete(
        {
          tag: t.tag,
          tier: t.tier as Tier,
          size: "s",
          exclude,
          taskId,
          departmentId: t.departmentId,
          messages: [
            { role: "system", content: 'You review patches. Reply JSON {"verdict":"pass"|"fail","reasons":["..."]}.' },
            { role: "user", content: `Task: ${t.title}\n\n${files.map((f) => `--- ${f.path}\n${f.content}`).join("\n").slice(0, 60_000)}` },
          ],
        },
        { fetch: bfetch, log },
      ).catch(() => null);
      reviewOk = review ? /"verdict"\s*:\s*"pass"/.test(review.text) : false;
      transcript.push(`review:${review?.model}:${review?.text.slice(0, 2000)}`);
    }

    if (!reviewOk) {
      const [{ attempts }] = await db.select({ attempts: tasks.attempts }).from(tasks).where(eq(tasks.id, taskId));
      if (attempts >= 2) {
        // Two failures ask the founder.
        await db.update(tasks).set({ status: "paused", pauseReason: "review_failed_twice", updatedAt: new Date() }).where(eq(tasks.id, taskId));
        await db.insert(approvalCards).values({ companyId: t.companyId, kind: "single", payload: { type: "task_review", taskId, title: t.title } });
      } else {
        await db.update(tasks).set({ status: "ready", updatedAt: new Date() }).where(eq(tasks.id, taskId));
      }
      await storeLog(t.departmentId, taskId, transcript);
      return { status: "retry" };
    }

    // 6. Commit with provenance trailers.
    const git = (...a: string[]) => exec("git", a, { cwd: dir });
    await git("init", "-q");
    await git("add", "-A");
    await git(
      "-c", "user.name=BuilderOS Agent", "-c", `user.email=${agent.accountId}@agents.builderos`,
      "commit", "-q", "-m", `${t.title}\n\nBuilderOS-Task: ${taskId}\nBuilderOS-Model: ${gen.model}\nBuilderOS-Provider: ${gen.provider}\nBuilderOS-Rail: ${gen.rail}\nBuilderOS-Agent: ${agent.accountId}`,
    );
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    if (process.env.CODE_REMOTE_URL) await git("push", "-q", process.env.CODE_REMOTE_URL, `HEAD:refs/heads/task/${taskId}`).catch((e) => log.warn({ err: e.message }, "push failed"));
    for (const f of files) await db.insert(provenance).values({ commitSha: sha, file: f.path, model: gen.model, provider: gen.provider });

    const logHash = await storeLog(t.departmentId, taskId, transcript);
    await db.update(tasks).set({ status: "review", commitSha: sha, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "review", sha, logHash };
  } catch (e) {
    if (e instanceof PurchasePending) {
      // Park; resumes on the approval event.
      await db.update(tasks).set({ status: "paused", pauseReason: `purchase:${e.requestId}`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      return { status: "paused" };
    }
    if (e instanceof PurchaseRejected) {
      await db.update(tasks).set({ status: "failed", pauseReason: e.reason, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      return { status: "failed" };
    }
    await db.update(tasks).set({ status: "ready", updatedAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.status, "running")));
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }); // wiped after
  }
}

/** Logs are sealed (XChaCha20-Poly1305) before storage; only the hash goes on chain with the verdict. */
async function storeLog(departmentId: string, taskId: string, lines: string[]) {
  const text = lines.join("\n\n");
  const hash = sha256Hex(text);
  const sealed = await seal(text, serverKey(env().SESSION_SECRET), 0, departmentId);
  await getDb()
    .insert(encryptedLogs)
    .values({ departmentId, taskId, keyVersion: 0, ciphertext: Buffer.from(serialize(sealed)), hashOnChain: hash });
  return hash;
}
