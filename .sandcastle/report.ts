/**
 * report.ts — the post-MR report phase: the pure half.
 *
 * The step this module decides for runs at the end of Phase 3, just AFTER the
 * Draft MR/PR is opened: a client skill reads the branch that was just pushed,
 * writes a review report, publishes it, and prints ONE url. That url is then
 * added to the MR body, so the human who opens the MR has something to read
 * before the diff.
 *
 * **Why after, when #41 deliberately put it before (issue #46).** The report
 * names its own origin — the change it explains — and a reader of the review
 * platform expects that origin to be the MR, clickable. Run before the create,
 * the phase cannot know the MR number, so every report produced in AFK named the
 * repository and nothing else. Ordering the phase after the create is the only
 * way the number exists when the skill needs it; the price is that the url can no
 * longer ride into the INITIAL body and must be written into it afterwards (see
 * `Host.updateChangeRequestDescription`).
 *
 * Three things shape this module, and none of them is cosmetic.
 *
 * **It is optional, and off by default (ADR-0004, "optional modules").**
 * `adopt --force` overwrites `main.ts` and `config.ts` in every consumer. A
 * phase hardcoded there would be imposed on consumers who have no such skill,
 * no publishing platform, and no wish for either. So `ProjectConfig.report` is
 * `null` by default and the phase does not exist until a consumer names it.
 *
 * **It is generic; the skill is project context (ADR-0003).** The Factory knows
 * "run a report skill in a sandbox and take a url from its stdout". It does not
 * know what `explain-diff` is, what `revue` is, or what a French review report
 * looks like. That lives in the consumer's `config.ts` and its prompt file.
 *
 * **Its failure must never cost the MR.** The report is a courtesy to the
 * reviewer; the MR is the work. A skill that times out, emits nothing, or emits
 * garbage degrades the MR body — and SAYS SO in it — exactly as a mute agent
 * summary already does (see mr-body.ts). `main.ts` owns the try/catch; this
 * module owns the classification, which is the part worth testing.
 *
 * Since #46 that guarantee is structural rather than careful: the MR is already
 * open when the phase starts, so nothing this phase does can prevent it. The
 * corollary is that a failure here is no longer confusable with a failed MR
 * creation — the phase runs OUTSIDE the try that records a `publish-pending.json`
 * trace, and a report crash therefore never files one.
 *
 * `main.ts` executes at import, so it has no unit test. Everything decidable is
 * therefore here.
 */

import { parseToolRequirements } from './image.ts';

/** A host directory the report sandbox needs mounted. */
export interface ReportMount {
  /** Host path. Tilde-expanded by the Engine. */
  readonly hostPath: string;
  /** Path inside the sandbox. */
  readonly sandboxPath: string;
}

/** The post-MR report phase, as a consumer configures it. `null` ⇒ no phase. */
export interface ReportConfig {
  /** The skill the report agent must invoke, by name. Reported in the MR body so
   *  a reader knows which doctrine produced what they are about to read. */
  readonly skill: string;
  /** Prompt file driving the report sandbox, resolved against the repo root like
   *  every other `promptFile`. */
  readonly promptFile: string;
  /** Whose provider and model the report agent borrows. Writing a report is a
   *  reading-and-explaining job, so `reviewer` is the sane default — but a
   *  consumer who splits providers may want otherwise. */
  readonly role: 'planner' | 'implementer' | 'reviewer';
  /** Host directories the sandbox needs: the skill itself, and the durable drop
   *  where a degraded run leaves its package. A symlinked skill in the host's
   *  `~/.claude/skills` is NOT visible in a sandbox — the Engine mounts only the
   *  worktree — so a consumer must mount the real directory, resolved. */
  readonly mounts: readonly ReportMount[];
  /** Extra environment for the report sandbox. This is where a consumer points
   *  the skill at its platform and at a package drop that outlives the run. */
  readonly env: Readonly<Record<string, string>>;
  /** Give up after this many seconds. A report is a courtesy; it does not get to
   *  hold a run hostage. */
  readonly idleTimeoutSeconds: number;
  /**
   * The env KEYS the skill needs to reach a publishable instance — the platform's
   * address, its credential, whatever this consumer's skill actually dials
   * (issue #47). Names only: the Factory never learns what a value means, and
   * `decideReportReadiness` never reads one.
   *
   * Declared here so the run can say, BEFORE it spends a half-hour sandbox,
   * whether the phase has any way to publish. Omitted (or empty) is allowed and
   * yields an HONEST `unverifiable` verdict, not a healthy-looking one.
   */
  readonly requiredEnv?: readonly string[];
  /**
   * The sandbox CAPABILITIES the skill needs — a command on `PATH`, a module the
   * image's `python3` can import (issue #53). Declared with a probe-kind prefix,
   * because a bare name is not probeable: `cmd:gh`, `py:edge_tts`.
   *
   * Same doctrine as `requiredEnv`, one dimension over: names only, and the
   * Factory never learns what a tool DOES. What this closes is the asymmetry that
   * cost a consumer a half-hour run — the run could say before spending whether
   * the phase could reach an instance, and could say nothing about whether the
   * image carried the module the skill imports. A premise a build depends on
   * cannot live in a Dockerfile comment; it goes stale without a sound.
   *
   * Omitted (or empty) is the default and changes nothing: a phase that needs no
   * third-party tool is not in trouble. The absence is stated in the dry run
   * (`describeToolProbe`) rather than folded into this verdict, so it is said
   * where statements belong without crying wolf every round.
   */
  readonly requiredTools?: readonly string[];
}

/** What the phase produced, as the MR body needs to state it. */
export type ReportOutcome =
  | { readonly kind: 'published'; readonly skill: string; readonly url: string }
  /** The phase ran and did not produce a url. `reason` is shown to the reviewer:
   *  an absence is never mute. */
  | { readonly kind: 'failed'; readonly skill: string; readonly reason: string }
  /** The phase produced no url but left a replayable package behind — the
   *  degradation the platform's AFK path exists for. The reviewer sees the
   *  command that finishes the job. */
  | { readonly kind: 'degraded'; readonly skill: string; readonly reason: string; readonly replay: string };

/**
 * The marker the report agent wraps its result in.
 *
 * A bare url scraped from stdout would match the first link in any chatter the
 * agent emits — a docs link, an issue url, the repo itself. The marker makes the
 * claim explicit: everything else on stdout is noise by construction.
 */
const OPEN = '<report>';
const CLOSE = '</report>';

/** Same idea, for the degraded path: the CLI's replay command, verbatim. */
const REPLAY_OPEN = '<report-replay>';
const REPLAY_CLOSE = '</report-replay>';

function lastBlock(stdout: string, open: string, close: string): string | null {
  // Last, not first: an agent that retries prints the earlier attempt too, and
  // the final block is the one that describes what actually happened.
  const end = stdout.lastIndexOf(close);
  if (end === -1) return null;
  const start = stdout.lastIndexOf(open, end);
  if (start === -1) return null;
  return stdout.slice(start + open.length, end).trim();
}

/**
 * Is this a url a reviewer can actually click from anywhere?
 *
 * A path is not a url (the platform's own rule: the skill "returns the url, not
 * a path"), and a loopback address is a url that only works on the machine that
 * printed it — pasting it into an MR is the exact confusion this rejects. The
 * consumer's platform makes the same judgement on its own side; here we only
 * need to refuse what is plainly unusable in an MR body.
 */
export function isReviewableUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // Credentials in the url would be pasted into the MR body and stay there. A report
  // url never needs them, so their presence is a leak, not an address.
  if (parsed.username !== '' || parsed.password !== '') return false;
  // Node renders an IPv6 hostname BRACKETED (`[::1]`). Comparing it to a bare `::1`
  // never matches, so the loopback refusal would quietly hold on IPv4 only — and
  // `http://[::1]:8766/r/x` is the same unusable address as `http://127.0.0.1:8766/r/x`.
  const host = parsed.hostname.toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare === '0.0.0.0' || bare === '::') return false;
  // An IPv4-mapped address is normalized to its HEX form by `new URL`:
  // `[::ffff:127.0.0.1]` comes back as `::ffff:7f00:1`. Matching only the dotted
  // spelling would let the mapped loopback through.
  if (bare === '::1' || /^::ffff:(127\.|7f00:)/.test(bare)) return false;
  if (/^127\./.test(bare)) return false;
  return bare.length > 0;
}

/**
 * Classify what the report sandbox left on stdout.
 *
 * Every path returns an outcome — there is no `null`, and that is deliberate.
 * The MR body must be able to say "no report, and here is why" as readily as it
 * says "here is the report". Silence is the one answer that would let a broken
 * phase look like a phase nobody enabled.
 */
export function classifyReport(skill: string, stdout: string): ReportOutcome {
  const replay = lastBlock(stdout, REPLAY_OPEN, REPLAY_CLOSE);
  const claimed = lastBlock(stdout, OPEN, CLOSE);

  if (claimed !== null && isReviewableUrl(claimed)) {
    return { kind: 'published', skill, url: claimed };
  }
  if (replay !== null && replay.length > 0) {
    return {
      kind: 'degraded',
      skill,
      reason:
        claimed === null
          ? "la publication n'a pas abouti — le rapport attend dans un paquet local"
          : `la publication n'a pas abouti et le rapport a rendu « ${truncate(claimed)} » au lieu d'une URL`,
      replay,
    };
  }
  if (claimed === null) {
    return { kind: 'failed', skill, reason: `aucun bloc ${OPEN}…${CLOSE} sur la sortie de la skill` };
  }
  if (claimed.length === 0) {
    return { kind: 'failed', skill, reason: `bloc ${OPEN}…${CLOSE} vide` };
  }
  return { kind: 'failed', skill, reason: `« ${truncate(claimed)} » n'est pas une URL qu'un relecteur peut ouvrir` };
}

function truncate(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The outcome of a phase that threw — a sandbox crash, a timeout, a bad mount. */
export function reportCrashed(skill: string, error: unknown): ReportOutcome {
  const reason = error instanceof Error ? error.message : String(error);
  return { kind: 'failed', skill, reason: truncate(reason, 300) };
}

/**
 * The outcome of a phase the run refused to start (issue #47).
 *
 * Same shape as any other absence — the MR body states it — but the reason names
 * the CAUSE (this sandbox had no way to reach a publishable instance) rather than
 * the symptom a spent sandbox would have produced half an hour later ("that is
 * not a url a reviewer can open"). Not a crash: nothing ran.
 */
export function reportSkipped(skill: string, reason: string): ReportOutcome {
  // The prefix is what keeps a skip from reading like a crash: both render through
  // the `failed` branch, and a reviewer must be able to tell "nothing ran, and here
  // is what was missing" from "it ran and broke".
  return { kind: 'failed', skill, reason: truncate(`la phase n'a pas été lancée — ${reason}`, 300) };
}

/**
 * Can this phase reach a publishable instance from inside its sandbox?
 *
 * The `chainableBases` precedent (issue #24, chain.ts): a run that cannot
 * possibly succeed says so BEFORE it spends anything, and the dry run renders the
 * same verdict. Here the price is a thirty-minute sandbox whose failure is only
 * discovered at the end.
 *
 * The resolution mirrors the Engine's `resolveEnv` exactly, because that — not
 * the operator's shell — is what the sandbox will see:
 *
 *   - a key in `report.env` arrives via `docker({ env })`; always reaches it;
 *   - a key DECLARED in `.sandcastle/.env` arrives with its file value, or with
 *     `process.env`'s when the declaration is empty (the Engine's per-key
 *     fallback);
 *   - a key merely exported in the operator's shell and NOT declared in `.env`
 *     never arrives. That is the trap this verdict exists to catch: it looks set
 *     on the host and is absent in the sandbox.
 *
 * Values are read only to tell empty from non-empty, and none is ever returned:
 * the verdict names keys, so it is printable in a dry run (issue #47, criterion 5).
 */
export type ReportReadiness =
  /** Every declared key reaches the sandbox. */
  | { readonly verdict: 'ready'; readonly checked: readonly string[] }
  /** Nothing was declared, so nothing could be checked — stated, not dressed up. */
  | { readonly verdict: 'unverifiable'; readonly message: string }
  /** At least one declared key never reaches the sandbox. The phase is skipped. */
  | { readonly verdict: 'unreachable'; readonly missing: readonly string[]; readonly message: string };

/**
 * What the tools dimension has to say (issue #53).
 *
 * Kept apart from the env dimension and merged by the caller, because the two
 * absences do not read alike: a key that never reaches the sandbox and a module
 * the image does not carry want different sentences and different fixes. One
 * verdict, distinct clauses.
 *
 * `says` carries every clause worth printing, whether or not anything is
 * actually missing — a malformed declaration is unprovable, not satisfied, and
 * has to be heard even when the round is otherwise green.
 */
function judgeTools(
  declared: readonly string[],
  probes: Readonly<Record<string, boolean>> | null,
): { readonly missing: readonly string[]; readonly says: readonly string[] } {
  if (declared.length === 0) return { missing: [], says: [] };
  if (probes === null) {
    return {
      missing: [],
      says: [
        "les capacités déclarées (`requiredTools` : " +
          declared.join(', ') +
          ") n'ont pas pu être sondées : docker est injoignable, ou l'image du sandbox " +
          "n'est pas construite.",
      ],
    };
  }
  const { ok, malformed } = parseToolRequirements(declared);
  const says: string[] = [];
  if (malformed.length > 0) {
    says.push(
      '`requiredTools` porte ' +
        malformed.join(', ') +
        " — une déclaration se préfixe par son mode de sondage (`cmd:` pour une commande " +
        "du `PATH`, `py:` pour un module importable), et son nom est un identifiant simple. " +
        'Sans cela, elle est insondable, donc non prouvée.',
    );
  }
  // `!== true` and not `=== false`: a requirement with no line in the probe
  // output is UNPROVEN, and an unknown falls on the absent side.
  const absent = ok.filter((req) => probes[req.raw] !== true).map((req) => req.raw);
  if (absent.length > 0) {
    says.push(
      "l'image du sandbox ne porte pas " +
        absent.join(', ') +
        " — la phase ne peut pas faire ce qu'elle annonce. Ajoutez-les à la couche projet " +
        '(`.sandcastle/Dockerfile`) PUIS reconstruisez l\'image : ' +
        '`npx @ai-hero/sandcastle docker build-image`. Une recette corrigée sans ' +
        "reconstruction laisse l'image telle quelle.",
    );
  }
  return { missing: absent, says };
}

/** The env-dimension sentences, kept as constants so the two dimensions can be
 *  merged without either one's wording drifting. */
const NO_ENV_DECLARED =
  "la phase de rapport ne déclare aucune clé (`requiredEnv`) : impossible de dire avant le " +
  "sandbox si elle peut joindre une instance publiable. Elle est tentée quand même.";

const envUnreachableMessage = (missing: readonly string[]): string =>
  `aucune instance publiable n'est joignable depuis ce sandbox — ${missing.join(', ')} ` +
  `n'y arrive pas. Une clé n'atteint le sandbox que si \`report.env\` la porte, ou si ` +
  `\`.sandcastle/.env\` la DÉCLARE (sa valeur peut alors venir de l'environnement).`;

export function decideReportReadiness(input: {
  readonly config: ReportConfig;
  /** Parsed `.sandcastle/.env` — the ONE file the Engine merges into a sandbox. */
  readonly dotEnv: Readonly<Record<string, string>>;
  /** The host environment, consulted only as the Engine's per-declared-key fallback. */
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  /**
   * What the sandbox image was found to carry, keyed by declaration, or `null`
   * when docker could not be asked (issue #53). The docker IO is main.ts's and
   * the probe mechanics are image.ts's; this function only judges. Omitted
   * behaves like `null`, which is why a consumer that declares no tool is
   * unaffected either way.
   */
  readonly toolProbes?: Readonly<Record<string, boolean>> | null;
}): ReportReadiness {
  const requiredEnv = input.config.requiredEnv ?? [];
  const requiredTools = input.config.requiredTools ?? [];
  const tools = judgeTools(requiredTools, input.toolProbes ?? null);

  const reaches = (key: string): boolean => {
    const fromReportEnv = input.config.env[key];
    if (typeof fromReportEnv === 'string' && fromReportEnv !== '') return true;
    // Declaration in .env is what makes the key flow at all; its value may come
    // from the file or, when the declaration is empty, from the environment.
    if (!Object.prototype.hasOwnProperty.call(input.dotEnv, key)) return false;
    return (input.dotEnv[key] ?? '') !== '' || (input.processEnv[key] ?? '') !== '';
  };
  const missingEnv = requiredEnv.length === 0 ? [] : requiredEnv.filter((key) => !reaches(key));

  // Precedence: unreachable beats unverifiable beats ready. A dimension that
  // proves an absence decides the verdict; a dimension that could only shrug
  // still gets its sentence into the message.
  const missing = [...missingEnv, ...tools.missing];
  if (missing.length > 0) {
    const clauses = [...(missingEnv.length > 0 ? [envUnreachableMessage(missingEnv)] : []), ...tools.says];
    return { verdict: 'unreachable', missing, message: clauses.join(' ') };
  }
  const shrugs = [...(requiredEnv.length === 0 ? [NO_ENV_DECLARED] : []), ...tools.says];
  if (shrugs.length > 0) return { verdict: 'unverifiable', message: shrugs.join(' ') };
  return { verdict: 'ready', checked: [...requiredEnv, ...requiredTools] };
}


/**
 * The branch strategy the report sandbox runs under (issue #47).
 *
 * Explicit, and in this module, because the Engine's DEFAULT for a bind-mount
 * provider is `{ type: 'head' }` — which bind-mounts the operator's working copy
 * and takes its current branch. Omitting the option (what main.ts did before)
 * therefore handed the report agent write access to the real repository, and
 * "change nothing in this repository" was a line in a prompt rather than a
 * mechanism. `merge-to-head` is no better: it merges whatever the agent committed
 * back into the branch the host has checked out.
 *
 * `{ type: 'branch' }` puts the agent in a throwaway worktree under
 * `.sandcastle/worktrees/`, on the branch that was just pushed. The worktree
 * shares the repository's object database, so `BASE_BRANCH...BRANCH` — the diff
 * the prompt names — stays readable; `baseBranch` only matters on the path where
 * the branch does not exist locally.
 */
export function reportBranchStrategy(input: { readonly branch: string; readonly base: string }): {
  readonly type: 'branch';
  readonly branch: string;
  readonly baseBranch: string;
} {
  return { type: 'branch', branch: input.branch, baseBranch: input.base };
}

/**
 * The MR-body section for a report outcome, or `null` when the phase is off.
 *
 * French, like the rest of the body. Placed high in the MR by `mr-body.ts`,
 * because a report that explains the change is worth more before the diff than
 * after it.
 */
export function renderReport(outcome: ReportOutcome | null): string | null {
  if (outcome === null) return null;
  if (outcome.kind === 'published') {
    return [
      '## Rapport de revue',
      '',
      // The url is wrapped in `<>`: a url containing a `)` is accepted by `new URL`
      // and would otherwise close the markdown link early, spilling the rest into the body.
      `📖 **[Lire le rapport](<${outcome.url}>)** — produit par la skill \`${outcome.skill}\` à l'ouverture de cette MR.`,
    ].join('\n');
  }
  if (outcome.kind === 'degraded') {
    return [
      '## Rapport de revue',
      '',
      `⚠ La skill \`${outcome.skill}\` a écrit le rapport mais n'a pas pu le publier : ${outcome.reason}.`,
      'Le travail n\'est pas perdu — il se rejoue par :',
      '',
      '```sh',
      outcome.replay,
      '```',
    ].join('\n');
  }
  return [
    '## Rapport de revue',
    '',
    `⚠ Aucun rapport pour cette MR : ${outcome.reason}.`,
    `La MR est ouverte quand même — un rapport manquant ne retient pas le travail. Relancez \`${outcome.skill}\` à la main si vous le voulez.`,
  ].join('\n');
}

/**
 * Should the phase run for this branch?
 *
 * Only when a consumer configured it AND the branch actually carries work. A
 * report on an empty branch would spend a sandbox to explain nothing — and
 * `main.ts` never publishes such a branch anyway.
 */
export function shouldRunReport(config: ReportConfig | null, commitCount: number): boolean {
  return config !== null && commitCount > 0;
}

/**
 * The prompt substitutions the report agent receives.
 *
 * `{{DIFF_BASE}}`/`{{BRANCH}}` are what the skill diffs; the markers are passed
 * in so the prompt file and this module cannot disagree about the contract they
 * share. Two spellings of a marker is a phase that silently never reports.
 *
 * `MR_NUMBER`/`MR_URL` are the whole point of #46: the MR the report explains is
 * already open, and the skill needs its number to record a clickable origin. They
 * are EMPTY STRINGS, never absent, when the create could not be named (see
 * `parseCreatedChangeRequest`) — a `{{MR_NUMBER}}` left unsubstituted in the
 * prompt would reach the skill as literal braces, which is worse than a blank the
 * prompt file already tells the agent how to read.
 */
export function reportPromptArgs(input: {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly branch: string;
  readonly base: string;
  readonly changedLines: number;
  readonly skill: string;
  /** The open MR/PR's number, or `null` when it could not be determined. */
  readonly mrNumber: number | null;
  /** Its web url, or `null` for the same reason. */
  readonly mrUrl: string | null;
}): Record<string, string> {
  return {
    ISSUE_NUMBER: String(input.issueNumber),
    ISSUE_TITLE: input.issueTitle,
    BRANCH: input.branch,
    BASE_BRANCH: input.base,
    CHANGED_LINES: String(input.changedLines),
    REPORT_SKILL: input.skill,
    MR_NUMBER: input.mrNumber === null ? '' : String(input.mrNumber),
    MR_URL: input.mrUrl ?? '',
    REPORT_OPEN: OPEN,
    REPORT_CLOSE: CLOSE,
    REPORT_REPLAY_OPEN: REPLAY_OPEN,
    REPORT_REPLAY_CLOSE: REPLAY_CLOSE,
  };
}
