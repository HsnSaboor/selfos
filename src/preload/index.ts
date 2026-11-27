/**
 * Preload: the only privileged surface the renderer can reach.
 *
 * Electron 45 removed Node shims and Buffer from sandboxed preloads (STACK C-11),
 * so this file uses only `electron` + web APIs.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  type ApiName,
  type ApiParams,
  type ApiResult,
  type EventName,
  type Events,
  isApiChannel,
  isEventName,
  isValidEventPayload,
  type Result,
  type SelfOSBridge,
  transportFailure,
} from "../shared/api";

const bridge: SelfOSBridge = {
  invoke<K extends ApiName>(name: K, params: ApiParams<K>): Promise<Result<ApiResult<K>>> {
    // `ApiName` is a compile-time type only, so the name is checked against the
    // closed list at runtime too. Without this the bridge is a generic
    // `ipcRenderer.invoke` passthrough, which STACK §2.3/§3.4 forbid: it would
    // expose every channel the main process registers, not just the `Api` map.
    if (!isApiChannel(name)) {
      return Promise.resolve({ ok: false, error: `unknown channel: ${String(name)}` } as Result<
        ApiResult<K>
      >);
    }
    // `api.ts` promises the UI never sees a thrown error, but `invoke` rejects
    // if the main process throws outside the handler's try, if the channel is
    // unregistered, or if the window is torn down mid-call. Convert that to the
    // same discriminated union rather than passing the rejection through: every
    // loader is a `Promise.all`, so one rejection discarded the sibling results
    // and skipped the `setBusy(false)` / `setError` that follows the await.
    return (ipcRenderer.invoke(`selfos:${name}`, params) as Promise<Result<ApiResult<K>>>).catch(
      transportFailure<ApiResult<K>>,
    );
  },
  on<E extends EventName>(event: E, handler: (payload: Events[E]) => void): () => void {
    // Same reasoning as `invoke`: the event name is a compile-time type only.
    // Without the check, any main→renderer channel would be subscribable from
    // the renderer without a contract entry.
    if (!isEventName(event)) return () => undefined;
    const channel = `selfos:event:${event}`;
    // The payload is not trusted: `invoke` has a result union to absorb a bad
    // value, but an event is rendered directly, and a `theme-changed` push with
    // a missing `palette` threw inside App's own render (above the module error
    // boundary). An invalid payload is dropped rather than handed on.
    const listener = (_e: unknown, payload: unknown) => {
      if (!isValidEventPayload(event, payload)) {
        console.error(`[event] ${event}: malformed payload dropped`, payload);
        return;
      }
      handler(payload as Events[E]);
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("selfos", bridge);
