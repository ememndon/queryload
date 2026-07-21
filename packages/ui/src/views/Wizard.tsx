import { useEffect, useState } from 'react';
import type { HardwareProfile, ModelInfo } from '@queryload/shared';
import type { EngineClient } from '../api/client';
import { Modal } from '../Modal';

interface Props {
  client: EngineClient;
  onDone: () => void;
}

/**
 * First-run wizard (D71): hardware scan → model choice filtered to this machine
 * → add a first folder (with an indexing-time estimate) → land in the demo
 * workspace. Everything happens locally; the only network touch is the
 * user-initiated model download.
 */
export function Wizard({ client, onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [models, setModels] = useState<readonly ModelInfo[]>([]);
  const [pathInput, setPathInput] = useState('');
  const [estimate, setEstimate] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void client.listModels().then((r) => {
      setHw(r.hardware);
      setModels(r.models);
    });
  }, [client]);

  const eligible = models.filter((m) => m.eligibility.status !== 'blocked');

  const finish = (): void => {
    try {
      window.localStorage.setItem('queryload.wizardComplete', '1');
    } catch {
      /* ignore */
    }
    onDone();
  };

  return (
    <Modal titleId="wizard-title" onClose={finish} overlayClassName="wizard" cardClassName="wizard-card">
      <>
        {step === 0 && (
          <>
            <div className="wizard-title" id="wizard-title">
              Welcome to QueryLoad
            </div>
            <p className="wizard-step">
              Your documents, your hardware, your answers. Nothing leaves the building. Let’s check
              this computer and set you up — it takes a minute.
            </p>
            {hw && (
              <div className="hw-card" style={{ marginTop: 16 }}>
                <span>{hw.totalRamGB} GB RAM</span>
                <span className="muted">·</span>
                <span>{hw.cpuThreads} CPU threads</span>
                <span className="muted">·</span>
                <span>
                  {hw.gpus.length ? hw.gpus.map((g) => g.name).join(', ') : 'No dedicated GPU'}
                </span>
                <span className="muted">·</span>
                <span>{Math.floor(hw.freeDiskGB)} GB free</span>
              </div>
            )}
            <div className="wizard-actions">
              <button className="btn btn-primary" disabled={!hw} onClick={() => setStep(1)}>
                Continue
              </button>
              <button className="btn btn-ghost" onClick={finish}>
                Skip setup
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="wizard-title" id="wizard-title">
              Choose a model
            </div>
            <p className="wizard-step">
              These models fit this computer. You can change it later under Settings → Model.
            </p>
            <div
              className="model-list"
              style={{ marginTop: 12, maxHeight: 280, overflowY: 'auto' }}
            >
              {eligible.map((m) => (
                <div className="model-row" key={m.entry.id}>
                  <div className="model-main">
                    <div className="model-name">{m.entry.name}</div>
                    <div className="model-reason">{m.eligibility.reason}</div>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn"
                      disabled={m.installed || m.download?.state === 'downloading'}
                      onClick={() => void client.startDownload(m.entry.id).catch(() => undefined)}
                    >
                      {m.installed
                        ? 'Installed'
                        : m.download?.state === 'downloading'
                          ? 'Downloading…'
                          : 'Download'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="btn btn-primary" onClick={() => setStep(2)}>
                Continue
              </button>
              <button className="btn btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="wizard-title" id="wizard-title">
              Add your first folder
            </div>
            <p className="wizard-step">
              Point QueryLoad at a folder of documents. It indexes everything on this machine.
            </p>
            <div className="path-input-row" style={{ marginTop: 12 }}>
              <input
                className="path-input"
                placeholder="Paste a folder path…"
                value={pathInput}
                onChange={(e) => {
                  setPathInput(e.target.value);
                  setEstimate(null);
                }}
                spellCheck={false}
              />
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.queryload.pickFolder().then((p) => {
                    if (p) setPathInput(p);
                  })
                }
              >
                Browse…
              </button>
            </div>
            {estimate && <div className="wizard-step">{estimate}</div>}
            <div className="wizard-actions">
              <button
                className="btn"
                disabled={!pathInput.trim() || working}
                onClick={() =>
                  void (async () => {
                    setWorking(true);
                    try {
                      const est = await client.estimate(pathInput.trim());
                      setEstimate(est.summary);
                    } catch {
                      setEstimate('Could not estimate — the folder may be empty or unavailable.');
                    } finally {
                      setWorking(false);
                    }
                  })()
                }
              >
                Estimate time
              </button>
              <button
                className="btn btn-primary"
                disabled={!pathInput.trim() || working}
                onClick={() =>
                  void (async () => {
                    setWorking(true);
                    try {
                      await client.addPath(pathInput.trim());
                      finish();
                    } catch {
                      setEstimate('That folder could not be added. Check the path and try again.');
                    } finally {
                      setWorking(false);
                    }
                  })()
                }
              >
                Add & finish
              </button>
              <button className="btn btn-ghost" onClick={finish}>
                Skip — explore the demo
              </button>
            </div>
          </>
        )}
      </>
    </Modal>
  );
}
