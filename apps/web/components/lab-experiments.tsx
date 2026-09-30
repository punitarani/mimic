'use client';

import type { ConfigRecord, ExperimentRecord } from '@mimic/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, type ExperimentRequest } from '@/lib/api';
import { Button, ErrorText, Input, Textarea } from './ui';

type Arm = ExperimentRecord['arms'][number];

const pretty = (json: string) => JSON.stringify(JSON.parse(json), null, 2);
const configName = (c: ConfigRecord) => `${c.label ?? 'unlabeled'} · ${c.hash.slice(0, 8)}`;

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Registers a new immutable config derived from an existing one (PLAN §12.1). */
function NewConfig({ configs }: { configs: ConfigRecord[] }) {
  const [base, setBase] = useState(configs[0]?.hash ?? '');
  const [label, setLabel] = useState('');
  const [json, setJson] = useState(configs[0] ? pretty(configs[0].json) : '{}');
  const { busy, error, run } = useAction();

  const pick = (hash: string) => {
    setBase(hash);
    const c = configs.find((x) => x.hash === hash);
    if (c) setJson(pretty(c.json));
  };
  const save = () =>
    run(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error('The config is not valid JSON.');
      }
      await api.createConfig(label.trim(), parsed);
      setLabel('');
    });

  return (
    <div className="space-y-2">
      <label htmlFor="cfg-base" className="block text-[13px] font-medium">
        Derive a config from
      </label>
      <select
        id="cfg-base"
        value={base}
        onChange={(e) => pick(e.target.value)}
        className="h-9 w-full rounded-[10px] border border-line bg-raised px-2 text-[13px]"
      >
        {configs.map((c) => (
          <option key={c.hash} value={c.hash}>
            {configName(c)}
          </option>
        ))}
      </select>
      <Textarea
        aria-label="Config JSON"
        value={json}
        onChange={(e) => setJson(e.target.value)}
        rows={10}
        spellCheck={false}
        className="font-mono text-[12px]"
      />
      <div className="flex gap-2">
        <Input
          aria-label="Config label"
          placeholder="Label, e.g. cfg.bald.v1"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-9 text-[13px]"
        />
        <Button size="sm" onClick={save} disabled={busy || !label.trim()}>
          Register
        </Button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

/** Builds an experiment: arms are configs with weights; new mimics are allocated by hash(mimicId). */
function NewExperiment({ configs }: { configs: ConfigRecord[] }) {
  const first = configs[0]?.hash ?? '';
  const [name, setName] = useState('');
  const [arms, setArms] = useState<Arm[]>([
    { arm: 'control', configHash: first, weight: 1 },
    { arm: 'treatment', configHash: configs[1]?.hash ?? first, weight: 1 },
  ]);
  const { busy, error, run } = useAction();
  const edit = (i: number, patch: Partial<Arm>) =>
    setArms((xs) => xs.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const valid =
    name.trim() &&
    arms.length >= 2 &&
    arms.every((a) => a.arm.trim() && a.configHash && a.weight > 0) &&
    new Set(arms.map((a) => a.arm.trim())).size === arms.length;
  const save = (status: ExperimentRequest['status']) =>
    run(async () => {
      await api.saveExperiment({ name: name.trim(), status, arms });
      setName('');
    });

  return (
    <div className="space-y-2">
      <Input
        aria-label="Experiment name"
        placeholder="Experiment name, e.g. E3 selector: entropy vs BALD"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-9 text-[13px]"
      />
      {arms.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: arms are edited in place by position
        <div key={i} className="grid grid-cols-[1fr_2fr_4rem_auto] items-center gap-2">
          <Input
            aria-label={`Arm ${i + 1} name`}
            value={a.arm}
            onChange={(e) => edit(i, { arm: e.target.value })}
            className="h-9 text-[13px]"
          />
          <select
            aria-label={`Arm ${i + 1} config`}
            value={a.configHash}
            onChange={(e) => edit(i, { configHash: e.target.value })}
            className="h-9 min-w-0 rounded-[10px] border border-line bg-raised px-2 text-[13px]"
          >
            {configs.map((c) => (
              <option key={c.hash} value={c.hash}>
                {configName(c)}
              </option>
            ))}
          </select>
          <Input
            aria-label={`Arm ${i + 1} weight`}
            type="number"
            min={0.1}
            step={0.1}
            value={a.weight}
            onChange={(e) => edit(i, { weight: Number(e.target.value) })}
            className="h-9 text-[13px]"
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove arm ${i + 1}`}
            disabled={arms.length <= 2}
            onClick={() => setArms((xs) => xs.filter((_, j) => j !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setArms((xs) => [...xs, { arm: `arm${xs.length + 1}`, configHash: first, weight: 1 }])
          }
        >
          Add arm
        </Button>
        <Button size="sm" onClick={() => save('active')} disabled={busy || !valid}>
          Start experiment
        </Button>
        <Button size="sm" variant="secondary" onClick={() => save('draft')} disabled={busy || !valid}>
          Save draft
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        Starting an experiment stops the active one. Only new mimics are allocated; a mimic's config never
        changes.
      </p>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

function ExperimentRow({ e, configs }: { e: ExperimentRecord; configs: ConfigRecord[] }) {
  const { busy, error, run } = useAction();
  const setStatus = (status: ExperimentRecord['status']) =>
    run(() => api.saveExperiment({ id: e.id, name: e.name, status, arms: e.arms }));
  const label = (hash: string) => configs.find((c) => c.hash === hash)?.label ?? hash.slice(0, 8);
  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="font-medium">{e.name}</span>{' '}
          <span className={e.status === 'active' ? 'text-moss' : 'text-muted'}>· {e.status}</span>
        </span>
        {e.status === 'active' ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus('stopped')}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus('active')}>
            Start
          </Button>
        )}
      </div>
      <div className="text-muted">
        {e.arms.map((a) => `${a.arm} (${a.weight}) ${label(a.configHash)}`).join(' · ')}
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </li>
  );
}

export function ExperimentsPanel({
  configs,
  experiments,
}: {
  configs: ConfigRecord[];
  experiments: ExperimentRecord[];
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="space-y-6">
        <div>
          <h3 className="mb-2 text-[14px] font-medium">Experiments</h3>
          {experiments.length === 0 ? (
            <p className="text-[13px] text-muted">None yet.</p>
          ) : (
            <ul className="space-y-3 text-[13px]">
              {experiments.map((e) => (
                <ExperimentRow key={e.id} e={e} configs={configs} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-[14px] font-medium">New experiment</h3>
          <NewExperiment configs={configs} />
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-[14px] font-medium">Configs</h3>
        <ul className="mb-4 space-y-1 text-[13px]">
          {configs.map((c) => (
            <li key={c.hash}>
              <span className="font-medium">{c.label ?? 'unlabeled'}</span>{' '}
              <code className="text-muted">{c.hash.slice(0, 12)}</code>
            </li>
          ))}
        </ul>
        <NewConfig configs={configs} />
      </div>
    </div>
  );
}
