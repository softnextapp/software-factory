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
