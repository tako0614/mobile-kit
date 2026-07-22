import {
  MOBILE_SIGNIN_REQUIREMENTS,
  mobileWireRequirement,
  type MobileHostWireBundle,
  type MobileWireBlocks,
  type MobileWireRequirementId,
} from "./contract/mobile-discovery.ts";

/**
 * Producer/consumer conformance for the mobile host wire.
 *
 * `discoverHost` runs this against a live host, but the same function is the
 * gate a producer repo runs against its own generated document: the two known
 * defect classes (a renamed product token, a missing `oidcClientId`) are only
 * visible when both sides are compared, and neither side's own unit tests can
 * see them alone.
 */
export interface MobileWireViolation {
  readonly requirement: MobileWireRequirementId;
  readonly blocks: MobileWireBlocks;
  readonly detail: string;
}

export function checkMobileHostWire(
  bundle: MobileHostWireBundle,
): readonly MobileWireViolation[] {
  const violations: MobileWireViolation[] = [];
  for (const requirement of MOBILE_SIGNIN_REQUIREMENTS) {
    const detail = requirement.evaluate(bundle);
    if (detail) {
      violations.push({
        requirement: requirement.id,
        blocks: requirement.blocks,
        detail,
      });
    }
  }
  return violations;
}

/** Throws on the first violation, connect blockers first. */
export function assertMobileHostWire(bundle: MobileHostWireBundle): void {
  const violations = checkMobileHostWire(bundle);
  const blocking =
    violations.find((violation) => violation.blocks === "connect") ??
    violations[0];
  if (blocking) throw new Error(blocking.detail);
}

export function mobileWireBlocker(
  violations: readonly MobileWireViolation[] | undefined,
  requirement: MobileWireRequirementId,
): string | undefined {
  return violations?.find((violation) => violation.requirement === requirement)
    ?.detail;
}

export function mobileWireRequirementSummary(
  requirement: MobileWireRequirementId,
): string {
  return mobileWireRequirement(requirement).summary;
}

/**
 * A host document a consumer cannot use, paired with the requirements it must
 * violate. The kit ships the shape so producer repos and shell test suites can
 * keep their own recorded corpus of real host output in the same form; the kit
 * itself stores no product-named cases, because it knows no product nouns.
 */
export interface MobileWireDefectCase {
  readonly id: string;
  /** Where the disagreement lives, in producer terms. */
  readonly producer: string;
  readonly why: string;
  readonly bundle: MobileHostWireBundle;
  readonly expected: readonly MobileWireRequirementId[];
}

/**
 * Runs a recorded corpus and returns the entries whose reported requirement
 * set differs from the recorded one. A corpus that stops reproducing is a
 * check that has gone dead, which is how a live defect becomes invisible
 * again — so this is the assertion a shell or producer suite makes over its
 * own recordings.
 */
export function checkMobileWireDefectCorpus(
  corpus: readonly MobileWireDefectCase[],
): readonly { readonly id: string; readonly reported: readonly MobileWireRequirementId[] }[] {
  const drifted: {
    readonly id: string;
    readonly reported: readonly MobileWireRequirementId[];
  }[] = [];
  for (const entry of corpus) {
    const reported = checkMobileHostWire(entry.bundle)
      .map((violation) => violation.requirement)
      .sort();
    const expected = [...entry.expected].sort();
    if (
      reported.length !== expected.length ||
      reported.some((id, index) => id !== expected[index])
    ) {
      drifted.push({ id: entry.id, reported });
    }
  }
  return drifted;
}
