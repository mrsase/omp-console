import { useEffect, useMemo, useRef, useState } from "react";
import type { DialogRecord, RawFrame } from "./protocol/types";
import { answerFrame, firstPromptTitle } from "./store/commands";
import { ConsoleClient } from "./store/client";
import { defaultStore, useAppState, useStore } from "./store/hooks";
import { isFieldAsk, isApprovalOptions } from "./protocol/dialogs";
import { openDialogs } from "./store/selectors";
import { Rail } from "./components/Rail";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { Dialogs } from "./components/Dialogs";
import { SettingsSheet } from "./components/SettingsSheet";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { PlanPanel } from "./components/PlanPanel";
import { useTheme } from "./components/hooks";

export function App({ clientOverride }: { clientOverride?: ConsoleClient | null }) {
  const store = useStore();
  const state = useAppState();
  const { theme, toggle } = useTheme();
  const [railOpen, setRailOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planTouched, setPlanTouched] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [readMode, setReadMode] = useState(false);
  const [resuming, setResuming] = useState<Set<string>>(new Set());
  const clientRef = useRef<ConsoleClient | null>(clientOverride ?? null);

  useEffect(() => {
    if (clientOverride !== undefined) return;
    const created = new ConsoleClient({ store });
    clientRef.current = created;
    void created.start();
    return () => {
      created.dispose();
      clientRef.current = null;
    };
  }, [clientOverride, store]);

  const selectedId = state.selected;
  const thread = selectedId ? state.threads[selectedId] : undefined;
  const session = selectedId ? state.sessions[selectedId] : undefined;
  const threads = useMemo(
    () => state.threadOrder.map((id) => state.threads[id]).filter((entry): entry is NonNullable<typeof entry> => !!entry),
    [state.threadOrder, state.threads],
  );

  useEffect(() => {
    if (!session || planTouched) return;
    if (typeof window === "undefined" || !window.matchMedia("(min-width: 1280px)").matches) return;
    if (session.todoPhases.length > 0) setPlanOpen(true);
  }, [session, planTouched]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (readMode) {
        event.preventDefault();
        setReadMode(false);
        return;
      }
      if (railOpen) setRailOpen(false);
      if (planOpen) setPlanOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readMode, railOpen, planOpen]);

  const send = (frame: RawFrame) => {
    if (!selectedId) return;
    if (frame.type === "prompt" && session && !session.sessionName && typeof frame.message === "string") {
      const title = firstPromptTitle(frame.message);
      if (title) clientRef.current?.sendCommand(selectedId, title);
    }
    const sent = clientRef.current?.sendCommand(selectedId, frame);
    if (sent === false) store.addNotice("error", `could not send ${frame.type}`);
  };

  const stop = () => {
    if (!selectedId || !session) return;
    const queued = session.queue.steering.length + session.queue.followUp.length;
    if (queued > 0) {
      store.abortAndRestoreQueue(selectedId, (frame) => {
        clientRef.current?.sendCommand(selectedId, frame);
      });
    } else {
      send({ type: "abort" });
    }
  };

  const select = (id: string) => {
    if (clientRef.current) clientRef.current.selectThread(id);
    else store.setSelected(id);
    setRailOpen(false);
  };

  const closeThread = (id: string) => {
    if (clientRef.current) void clientRef.current.deleteThread(id);
    else store.dispatch({ op: "thread_removed", id });
  };

  const resume = (entry: { path: string; cwd: string }) => {
    setResuming((current) => new Set(current).add(entry.path));
    if (!clientRef.current) {
      store.addNotice("error", "not connected to the console server");
      setResuming((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    void clientRef.current
      .createThread({ cwd: entry.cwd, resume: entry.path })
      .finally(() =>
        setResuming((current) => {
          const next = new Set(current);
          next.delete(entry.path);
          return next;
        }),
      );
  };

  const localCommand = (name: string) => {
    if (name === "plan") {
      setPlanTouched(true);
      setPlanOpen((value) => !value);
    } else if (name === "settings") {
      setSettingsOpen(true);
    } else if (name === "theme") {
      toggle();
    } else if (name === "read") {
      setReadMode(true);
    } else if (name === "new") {
      setNewOpen(true);
    }
  };

  const answer = (dialog: DialogRecord, payload: Record<string, unknown>, label?: string) => {
    if (!selectedId) return;
    const request = dialog.request;
    const frame = answerFrame(request.id, payload);
    send(frame);
    store.resolveDialog(selectedId, request.id, payload.cancelled ? "cancelled" : "answered", label);
    const field = isFieldAsk(request) || request.field;
    if (field && !payload.cancelled) {
      const value = typeof payload.value === "string" ? payload.value : "";
      if (value) store.recordFieldAnswer(selectedId, request.title ?? "answer", value);
    }
    if (isApprovalOptions(request.options) && request.approval && typeof payload.value === "string") {
      store.recordFieldAnswer(selectedId, request.approval.heading, payload.value);
    }
  };

  const startSession = (body: { cwd: string; resume?: string; model?: string; thinking?: string }) => {
    setNewOpen(false);
    if (!clientRef.current) {
      store.addNotice("error", "not connected to the console server");
      return;
    }
    void clientRef.current.createThread(body);
  };

  const browse = (path?: string) => {
    if (clientRef.current) return clientRef.current.browseFs(path);
    return Promise.reject(new Error("console server not connected"));
  };

  const sheet = session ? openDialogs(session)[0] : undefined;
  const lastNotice = state.notices[state.notices.length - 1];

  return (
    <div className="app" data-read={readMode ? "true" : "false"} data-rail={railOpen ? "true" : "false"}>
      <Rail
        threads={threads}
        sessions={state.sessions}
        recent={state.recent}
        selected={selectedId}
        connection={state.connection}
        version={state.info?.version ?? state.version}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        onSelect={select}
        onNew={() => setNewOpen(true)}
        onCloseThread={closeThread}
        onResume={resume}
        resuming={resuming}
      />
      {railOpen ? (
        <button type="button" className="rail-scrim" aria-label="Close sessions" onClick={() => setRailOpen(false)} />
      ) : null}
      <div className="main">
        <Header
          session={session}
          connection={state.connection}
          planOpen={planOpen}
          theme={theme}
          onTogglePlan={() => {
            setPlanTouched(true);
            setPlanOpen((value) => !value);
          }}
          onSettings={() => setSettingsOpen(true)}
          onNewSession={() => setNewOpen(true)}
          onReadMode={() => setReadMode(true)}
          onToggleTheme={toggle}
          onOpenRail={() => setRailOpen(true)}
          onCommand={send}
          onCloseSession={() => selectedId && closeThread(selectedId)}
        />
        <div className="work">
          {session ? (
            <Transcript session={session} threadId={session.id} onClearUnknown={(id) => store.clearUnknown(id)} />
          ) : (
            <div className="transcript">
              <div className="transcript-empty">
                <div className="empty-traces" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <h2>No session selected</h2>
                <p>Start a session in any folder, or resume one from the rail. Nothing leaves this machine.</p>
                <p style={{ marginTop: 16 }}>
                  <button type="button" className="primary" onClick={() => setNewOpen(true)}>
                    New session
                  </button>
                </p>
              </div>
            </div>
          )}
          {planOpen && session ? <PlanPanel phases={session.todoPhases} onClose={() => setPlanOpen(false)} /> : null}
        </div>
        {session ? (
          <Composer
            threadId={session.id}
            session={session}
            connected={state.connection === "open"}
            onSend={send}
            onStop={stop}
            onLocalCommand={localCommand}
            onEditorConsumed={() => store.clearEditorText(session.id)}
            restoredInput={session.restoredInput}
            onRestoredConsumed={() => store.clearRestoredInput(session.id)}
          />
        ) : null}
      </div>

      {readMode ? (
        <button type="button" className="read-exit" onClick={() => setReadMode(false)}>
          exit read
        </button>
      ) : null}

      {sheet && session ? <Dialogs session={session} onAnswer={answer} /> : null}
      {settingsOpen && session ? (
        <SettingsSheet
          session={session}
          onClose={() => setSettingsOpen(false)}
          onCommand={send}
          theme={theme}
          onToggleTheme={toggle}
        />
      ) : null}
      {newOpen ? (
        <NewSessionDialog
          sessionRoot={state.info?.sessionRoot ?? ""}
          defaultCwd={thread?.cwd ?? session?.meta?.cwd ?? ""}
          recent={state.recent}
          browse={browse}
          onClose={() => setNewOpen(false)}
          onStart={startSession}
        />
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {lastNotice?.message ?? ""}
      </div>
    </div>
  );
}

export { defaultStore };
