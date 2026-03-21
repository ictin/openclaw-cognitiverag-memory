import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';

const COG_RAG_BASE = 'http://127.0.0.1:8000';

type HealthMode = 'healthy' | 'degraded' | 'offline' | 'unknown';
type HealthState = {
  backendReachable: boolean;
  mode: HealthMode;
  lastSuccessAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  contextEngineSlot: string;
  fallbackMemoryMirrorActive: boolean;
  rollbackRecommended: boolean;
  rollbackReason: string | null;
  rollbackReady: boolean;
  lastRollbackAt: string | null;
};

const defaultHealthState = (): HealthState => ({
  backendReachable: false,
  mode: 'unknown',
  lastSuccessAt: null,
  lastFailAt: null,
  lastError: null,
  consecutiveFailures: 0,
  contextEngineSlot: 'unknown',
  fallbackMemoryMirrorActive: false,
  rollbackRecommended: false,
  rollbackReason: null,
  rollbackReady: true,
  lastRollbackAt: null,
});

function withTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function postJson(path: string, body: any, timeoutMs = 3000) {
  const t = withTimeoutSignal(timeoutMs);
  try {
    const r = await fetch(`${COG_RAG_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    let parsed: any = null;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed };
  } finally {
    t.done();
  }
}

export default function register(api: any) {
  const path = require('node:path');
  const pluginRoot = path.resolve(path.dirname(api?.source ?? api?.path ?? path.resolve('.')));
  const healthFile = path.join(pluginRoot, 'crag-health-state.json');
  const memoryFile = path.join(pluginRoot, 'MEMORY.md');
  const bootstrappedSlot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');

  try {
    api.logger?.info?.('[cognitiverag-memory] register-time path debug', {
      apiId: api?.id ?? null,
      apiSource: api?.source ?? null,
      apiRootDir: api?.rootDir ?? null,
      processCwd: process.cwd(),
      pluginRootCandidate: pluginRoot,
      healthFileCandidate: healthFile,
    });
    const fsSync = require('node:fs');
    const diagPath = '/tmp/cognitiverag-plugin-bootstrap-diagnostic.json';
    const diag = {
      timestamp: new Date().toISOString(),
      apiId: api?.id ?? null,
      apiSource: api?.source ?? null,
      apiRootDir: api?.rootDir ?? null,
      typeofApiSource: typeof api?.source,
      typeofApiRootDir: typeof api?.rootDir,
      processCwd: process.cwd(),
      pluginRootCandidate: pluginRoot,
      healthFile,
      pluginRootExists: fsSync.existsSync(pluginRoot),
      healthDirExists: fsSync.existsSync(path.dirname(healthFile)),
    };
    try { fsSync.writeFileSync(diagPath, JSON.stringify(diag, null, 2)); } catch {}
    const dir = healthFile.includes('/') ? healthFile.slice(0, healthFile.lastIndexOf('/')) : '.';
    if (dir) {
      try { fsSync.mkdirSync(dir, { recursive: true }); } catch {}
    }
    if (!fsSync.existsSync(healthFile)) {
      const initialState = {
        ...defaultHealthState(),
        backendReachable: false,
        mode: 'unknown',
        lastSuccessAt: null,
        lastFailAt: null,
        lastError: null,
        consecutiveFailures: 0,
        contextEngineSlot: bootstrappedSlot,
        fallbackMemoryMirrorActive: false,
        rollbackRecommended: false,
        rollbackReason: null,
        rollbackReady: true,
        lastRollbackAt: null,
      };
      fsSync.writeFileSync(healthFile, JSON.stringify(initialState, null, 2));
    }
  } catch {
    // keep bootstrapping best-effort and non-fatal
  }

  const readHealthState = async (): Promise<HealthState> => {
    try {
      const raw = await fs.readFile(healthFile, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...defaultHealthState(),
        ...parsed,
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? parsed?.contextEngineSlot ?? 'unknown'),
      };
    } catch {
      return {
        ...defaultHealthState(),
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
      };
    }
  };

  const writeHealthState = async (next: Partial<HealthState>) => {
    try {
      const current = await readHealthState();
      const merged: HealthState = {
        ...current,
        ...next,
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? current.contextEngineSlot ?? 'unknown'),
      };
      await fs.writeFile(healthFile, JSON.stringify(merged, null, 2));
      return merged;
    } catch {
      return null;
    }
  };

  const markSuccess = async () => {
    const now = new Date().toISOString();
    return writeHealthState({
      backendReachable: true,
      mode: 'healthy',
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      rollbackRecommended: false,
      rollbackReason: null,
    });
  };

  const appendRememberEntry = async (rawText: string) => {
    try {
      const text = String(rawText ?? '').trim();
      if (!text) return { ok: false, reason: 'empty' as const };
      const line = `- ${text}`;
      const existing = await fs.readFile(memoryFile, 'utf8').catch(() => '');
      if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
        return { ok: true, duplicate: true as const, line };
      }
      const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
      await fs.writeFile(memoryFile, next);
      return { ok: true, duplicate: false as const, line };
    } catch (error: any) {
      api.logger?.warn?.(`[cognitiverag-memory] remember mirror failed ${String(error?.message ?? error)}`);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  };

  const markFail = async (err: unknown) => {
    const current = await readHealthState();
    const now = new Date().toISOString();
    const msg = String((err as any)?.message ?? err ?? 'unknown error');
    const failures = Number(current?.consecutiveFailures ?? 0) + 1;
    const rollbackRecommended = failures >= 3;
    return writeHealthState({
      backendReachable: false,
      mode: rollbackRecommended ? 'rolled_back' : 'degraded',
      lastFailAt: now,
      lastError: msg,
      consecutiveFailures: failures,
      rollbackRecommended,
      rollbackReason: rollbackRecommended ? msg : current?.rollbackReason ?? null,
      rollbackReady: true,
      lastRollbackAt: rollbackRecommended ? now : current?.lastRollbackAt ?? null,
    });
  };

  const probeBackend = async () => {
    try {
      const probe = await postJson('/session_assemble_context', {
        session_id: '__crag_probe__',
        fresh_tail_count: 0,
        budget: 256,
      }, 1500);
      if (probe.status >= 200 && probe.status < 300) {
        const state = await markSuccess();
        return { ok: true, state, backendReachable: true, mode: 'healthy' as const };
      }
      const state = await markFail(`probe_status_${probe.status}`);
      return { ok: false, state, backendReachable: false, mode: state?.mode ?? 'degraded', reason: `HTTP ${probe.status}` };
    } catch (e) {
      const state = await markFail(e);
      return { ok: false, state, reason: String((e as any)?.message ?? e) };
    }
  };

  api.registerHttpRoute?.({
    path: '/cognitiverag-memory/status',
    auth: 'gateway',
    match: 'exact',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      try {
        const prior = await readHealthState();
        const probe = await probeBackend();
        const current = probe?.state ?? prior;
        const payload = {
          pluginLoaded: true,
          contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
          backendReachable: !!current?.backendReachable,
          mode: current?.mode ?? 'unknown',
          lastSuccessAt: current?.lastSuccessAt ?? null,
          lastFailAt: current?.lastFailAt ?? null,
          lastError: current?.lastError ?? null,
          consecutiveFailures: Number(current?.consecutiveFailures ?? 0),
          fallbackMemoryMirrorActive: !!current?.fallbackMemoryMirrorActive,
          rollbackRecommended: !!current?.rollbackRecommended,
          rollbackReason: current?.rollbackReason ?? null,
          rollbackReady: !!current?.rollbackReady,
          lastRollbackAt: current?.lastRollbackAt ?? null,
        };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        return true;
      } catch (e: any) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          pluginLoaded: true,
          contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
          backendReachable: false,
          mode: 'offline',
          lastSuccessAt: null,
          lastFailAt: new Date().toISOString(),
          lastError: String(e?.message ?? e),
          consecutiveFailures: 0,
          fallbackMemoryMirrorActive: false,
          rollbackRecommended: false,
          rollbackReason: String(e?.message ?? e),
          rollbackReady: true,
          lastRollbackAt: null,
        }));
        return true;
      }
    },
  });

  api.registerCommand?.({
    name: 'remember',
    description: 'Append an explicit durable memory note to the local fallback MEMORY.md.',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const note = Array.isArray(ctx?.args) ? ctx.args.join(' ').trim() : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.text ?? ctx?.message ?? ctx?.value ?? ctx?.args ?? '').trim();
        if (!note) return { text: 'Usage: /remember <durable fact or preference>' };
        const line = `- ${note}`;
        const existing = await fs.readFile(memoryFile, 'utf8').catch(() => '');
        if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
          return { text: 'Already remembered.' };
        }
        const header = existing.trim() ? '\n' : '# Fallback Memory Mirror\n';
        await fs.writeFile(memoryFile, `${header}${line}\n`, { flag: existing ? 'a' : 'w' } as any).catch(async () => {
          const current = existing.trim() ? existing : '# Fallback Memory Mirror\n';
          await fs.writeFile(memoryFile, `${current}${line}\n`);
        });
        return { text: `Remembered: ${note}` };
      } catch (error: any) {
        return { text: `Could not save memory: ${String(error?.message ?? error)}` };
      }
    },
  });

  api.registerCommand?.({
    name: 'crag-status',
    description: 'Show CognitiveRAG plugin/backend health and fallback status.',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const prior = await readHealthState();
      const probe = await probeBackend();
      const current = probe?.state ?? prior;
      const slot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');
      const lines = [
        'CognitiveRAG Status',
        `- contextEngine slot: ${slot}`,
        `- plugin loaded: yes`,
        `- backend reachable: ${current?.backendReachable ? 'yes' : 'no'}`,
        `- mode: ${current?.mode ?? 'unknown'}`,
        `- last success: ${current?.lastSuccessAt ?? 'never'}`,
        `- last failure: ${current?.lastFailAt ?? 'never'}`,
        `- last error: ${current?.lastError ?? 'none'}`,
        `- consecutive failures: ${current?.consecutiveFailures ?? 0}`,
        `- rollback recommended: ${current?.rollbackRecommended ? 'yes' : 'no'}`,
        `- rollback reason: ${current?.rollbackReason ?? 'none'}`,
        `- rollback ready: ${current?.rollbackReady ? 'yes' : 'no'}`,
        `- last rollback: ${current?.lastRollbackAt ?? 'never'}`,
        `- fallback memory mirror active: ${current?.fallbackMemoryMirrorActive ? 'yes' : 'no'}`,
      ];
      return { text: lines.join('\n') };
    },
  });

  api.registerContextEngine?.('cognitiverag-memory', () => ({
    info: {
      id: 'cognitiverag-memory',
      name: 'CognitiveRAG Memory Context Engine',
      version: '0.0.1',
      ownsCompaction: false,
    },

    async ingest(params: any) {
      const sessionId = String(params?.sessionId ?? 'unknown-session');
      const role = String(params?.message?.role ?? 'unknown');
      const text = String(params?.message?.content ?? '');
      const turnId = `${Date.now()}`;
      const messageId = `${turnId}-${role}`;

      api.logger?.info?.('[cognitiverag-memory] ingest called', {
        sessionId,
        sessionKey: params?.sessionKey,
        role,
      });

      try {
        const sender = role === 'assistant' ? 'assistant' : 'user';

        const msgRes = await postJson('/session_append_message', {
          session_id: sessionId,
          message_id: messageId,
          sender,
          text,
        });

        const partRes = text
          ? await postJson('/session_append_message_part', {
              session_id: sessionId,
              message_id: messageId,
              part_index: 0,
              text,
            })
          : null;

        const ctxRes = await postJson('/session_upsert_context_item', {
          item_id: `ctx-${messageId}`,
          session_id: sessionId,
          type: 'ingest',
          payload_json: {
            turn_id: turnId,
            role,
            session_key: params?.sessionKey ?? null,
            is_heartbeat: !!params?.isHeartbeat,
          },
        });

        const ok =
          msgRes.status === 200 &&
          (msgRes.body?.status === 'inserted' || msgRes.body?.status === 'updated');

        api.logger?.info?.(
          `[cognitiverag-memory] ingest forwarded ${JSON.stringify({
            sessionId,
            messageId,
            msgStatus: msgRes.status,
            msgBody: msgRes.body,
            partStatus: partRes?.status ?? null,
            partBody: partRes?.body ?? null,
            ctxStatus: ctxRes.status,
            ctxBody: ctxRes.body,
            ingested: ok,
          })}`,
        );

        if (ok) await markSuccess();
        else await markFail('ingest_not_inserted');

        return { ingested: ok };
      } catch (error: any) {
        api.logger?.warn?.(
          `[cognitiverag-memory] ingest forward failed ${JSON.stringify({
            sessionId,
            error: String(error?.message ?? error),
          })}`,
        );
        await markFail(error);
        return { ingested: false };
      }
    },

    async assemble(params: any) {
      const sessionId = String(params?.sessionId ?? 'unknown-session');
      const inputMessages = Array.isArray(params?.messages) ? params.messages : [];
      api.logger?.info?.('[cognitiverag-memory] assemble called', {
        sessionId,
        sessionKey: params?.sessionKey,
        inputMessages: inputMessages.length,
      });

      try {
        const budget = Number.isFinite(params?.tokenBudget) ? Math.max(256, Math.floor(params.tokenBudget)) : 4096;
        const freshTailCount = 20;

        const assemblyRes = await postJson('/session_assemble_context', {
          session_id: sessionId,
          fresh_tail_count: freshTailCount,
          budget,
        });

        const freshTail = Array.isArray(assemblyRes?.body?.fresh_tail) ? assemblyRes.body.fresh_tail : [];
        const summaries = Array.isArray(assemblyRes?.body?.summaries) ? assemblyRes.body.summaries : [];

        const messages = freshTail
          .map((m: any) => {
            const sender = String(m?.sender ?? 'user');
            const text = String(m?.text ?? '');
            if (!text) return null;
            return {
              role: sender === 'assistant' ? 'assistant' : 'user',
              content: text,
            };
          })
          .filter(Boolean);

        const rawSummaryItems = summaries
          .map((s: any) => String(s?.summary ?? '').trim())
          .filter(Boolean)
          .slice(0, 8);

        const maxSummaryTokens = Math.min(512, Math.max(96, Math.floor(budget * 0.25)));
        const maxSummaryChars = maxSummaryTokens * 4;
        const summaryItems: string[] = [];
        let usedChars = 0;
        for (const item of rawSummaryItems) {
          const prefixChars = summaryItems.length === 0 ? 0 : 3; // '\n- '
          if (usedChars + prefixChars + item.length <= maxSummaryChars) {
            summaryItems.push(item);
            usedChars += prefixChars + item.length;
            continue;
          }
          const remaining = maxSummaryChars - usedChars - prefixChars;
          if (remaining > 24) {
            summaryItems.push(item.slice(0, remaining - 1) + '…');
          }
          break;
        }

        const summaryText = summaryItems.join('\n- ');
        const systemPromptAddition = summaryText
          ? `Memory summary (older context; use as background, prefer fresh tail for exact wording):\n- ${summaryText}`
          : undefined;

        const estimatedTokens = Math.max(
          0,
          messages.reduce((n: number, m: any) => n + Math.ceil(String(m?.content ?? '').length / 4), 0) +
            Math.ceil((systemPromptAddition ?? '').length / 4),
        );
        const totalTokens = estimatedTokens;

        api.logger?.info?.(
          `[cognitiverag-memory] assemble forwarded ${JSON.stringify({
            sessionId,
            status: assemblyRes.status,
            freshTail: freshTail.length,
            summaries: summaries.length,
            summaryItemsUsed: summaryItems.length,
            maxSummaryTokens,
            maxSummaryChars,
            systemPromptAdditionChars: (systemPromptAddition ?? '').length,
            messages: messages.length,
            estimatedTokens,
            totalTokens,
          })}`,
        );

        if (assemblyRes.status >= 200 && assemblyRes.status < 300) await markSuccess();
        else await markFail(`assemble_status_${assemblyRes.status}`);

        return {
          messages,
          estimatedTokens,
          totalTokens,
          ...(systemPromptAddition ? { systemPromptAddition } : {}),
        };
      } catch (error: any) {
        api.logger?.warn?.(
          `[cognitiverag-memory] assemble forward failed ${JSON.stringify({
            sessionId,
            error: String(error?.message ?? error),
          })}`,
        );
        await markFail(error);
        return {
          messages: inputMessages,
          estimatedTokens: 0,
          totalTokens: 0,
        };
      }
    },

    async compact(params: any) {
      api.logger?.info?.('[cognitiverag-memory] compact called', {
        sessionId: params?.sessionId,
        sessionKey: params?.sessionKey,
        force: !!params?.force,
      });
      return {
        ok: true,
        compacted: false,
        reason: 'no-op',
      };
    },
  }));

  const buildHealthPayload = async () => {
    const prior = await readHealthState();
    const probe = await probeBackend();
    const current = probe?.state ?? prior;
    return {
      pluginLoaded: true,
      contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
      backendReachable: !!current?.backendReachable,
      mode: current?.mode ?? 'unknown',
      lastSuccessAt: current?.lastSuccessAt ?? null,
      lastFailAt: current?.lastFailAt ?? null,
      lastError: current?.lastError ?? null,
      consecutiveFailures: Number(current?.consecutiveFailures ?? 0),
      fallbackMemoryMirrorActive: !!current?.fallbackMemoryMirrorActive,
      rollbackRecommended: !!current?.rollbackRecommended,
      rollbackReason: current?.rollbackReason ?? null,
      rollbackReady: !!current?.rollbackReady,
      lastRollbackAt: current?.lastRollbackAt ?? null,
    };
  };

  const respondHealthJson = async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const payload = await buildHealthPayload();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return true;
    } catch (e: any) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        pluginLoaded: true,
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
        backendReachable: false,
        mode: 'offline',
        lastSuccessAt: null,
        lastFailAt: new Date().toISOString(),
        lastError: String(e?.message ?? e),
        consecutiveFailures: 0,
        fallbackMemoryMirrorActive: false,
        rollbackRecommended: false,
        rollbackReason: String(e?.message ?? e),
        rollbackReady: true,
        lastRollbackAt: null,
      }));
      return true;
    }
  };

  api.registerHttpRoute?.({
    path: '/cognitiverag-memory/status',
    auth: 'gateway',
    match: 'exact',
    handler: respondHealthJson,
  });

  api.registerHttpRoute?.({
    path: '/cognitiverag-memory/health',
    auth: 'gateway',
    match: 'exact',
    handler: respondHealthJson,
  });

}
