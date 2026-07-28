import { createHash } from "node:crypto";

export function validateMobileReleaseAttestation({
  attestation: value,
  evidenceBytes,
  product,
  productName,
  bundleId,
  releaseVersion,
}) {
  const results = [];
  const attestation = record(value);
  if (!attestation) {
    fail(
      "attestation.object_required",
      "release attestation must be a JSON object",
      "Provide a separately verified takos.mobile-release-attestation.v1 sidecar.",
    );
    return build();
  }

  expect(
    attestation.schema === "takos.mobile-release-attestation.v1",
    "release attestation schema is takos.mobile-release-attestation.v1",
    "attestation.schema_invalid",
    "Set schema to takos.mobile-release-attestation.v1.",
  );
  expect(
    attestation.state === "verified",
    "release attestation state is verified",
    "attestation.state_not_verified",
    "Keep declarations in the evidence file; only a verifier may set the sidecar state to verified.",
  );
  for (const [field, expected] of [
    ["product", product],
    ["productName", productName],
    ["bundleId", bundleId],
    ["releaseVersion", releaseVersion],
  ]) {
    if (expected === undefined) continue;
    expect(
      attestation[field] === expected,
      `release attestation ${field} matches product config`,
      `attestation.${field}_mismatch`,
      `Regenerate the attestation for the configured ${field}.`,
    );
  }
  const evidenceSha256 = `sha256:${createHash("sha256")
    .update(evidenceBytes)
    .digest("hex")}`;
  expect(
    attestation.evidenceSha256 === evidenceSha256,
    "release attestation binds the exact evidence file digest",
    "attestation.evidence_digest_mismatch",
    "Verify the current evidence file and record its exact sha256 digest.",
  );
  expectIsoTimestamp(attestation.verifiedAt, "attestation.verifiedAt");
  expectPrivateRef(attestation.verifierRef, "attestation.verifierRef");
  return build();

  function expect(condition, message, id, action) {
    if (condition) results.push({ kind: "ok", message });
    else fail(id, message, action);
  }

  function expectIsoTimestamp(value, label) {
    const text = optionalText(value);
    const timestamp = text ? Date.parse(text) : Number.NaN;
    expect(
      Boolean(
        text &&
          Number.isFinite(timestamp) &&
          new Date(timestamp).toISOString() === text,
      ),
      `${label} is an exact ISO timestamp`,
      "attestation.verified_at_invalid",
      "Record the verifier's exact UTC ISO timestamp.",
    );
  }

  function expectPrivateRef(value, label) {
    expect(
      optionalText(value)?.startsWith("private:") === true,
      `${label} is a private verifier reference`,
      "attestation.verifier_ref_invalid",
      "Record a public-safe private: reference to the independent verification receipt.",
    );
  }

  function fail(id, message, action) {
    results.push({ kind: "fail", id, message, action });
  }

  function build() {
    const issues = results.filter((result) => result.kind === "fail");
    return { valid: issues.length === 0, results, issues };
  }
}

export function mobileReleaseEvidenceSha256(evidenceBytes) {
  return `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
