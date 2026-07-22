import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import {
  createMobileClientController,
  type MobilePushNotificationCallbackInput,
  type MobilePushRegistrationCallbackInput,
  type MobileClientState,
} from "./client.ts";
import { resolvePushNotificationPath } from "./push-navigation.ts";
import type {
  MobileKnownHost,
  MobileProductAdapter,
  MobileSession,
  MobileSessionUnlockOptions,
  NativeBridge,
} from "./types.ts";
import { createMobileHostRouteUrl, openMobileHostRoute } from "./url.ts";
import { mobileErrorMessage } from "./error.ts";
import { copyMobileText } from "./shell.ts";
import type {
  MobileShellHostAction,
  MobileShellHostActionContext,
} from "./host-actions.ts";
export {
  defineMobileHostActions,
  type MobileShellHostAction,
  type MobileShellHostActionContext,
  type MobileShellNativeIntent,
} from "./host-actions.ts";

export interface MobileShellMetric<Home> {
  readonly label: string;
  readonly value: (home: Home | undefined) => number | undefined;
}

export interface MobileShellHomeExtraContext<Home> {
  readonly home: Home | undefined;
  readonly session: MobileSession;
  readonly refreshHome: () => Promise<void>;
  readonly openHostRoute: (path: string) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly writeClipboardText?: NativeBridge["writeClipboardText"];
}

export interface MobileShellCopy<Home> {
  readonly eyebrow?: string;
  readonly summary: string;
  readonly connectLabel: string;
  readonly onboardingTitle?: string;
  /**
   * Product logo asset. Preferred over `brandMark`: it lets a shell show the
   * same mark its web app ships instead of a letter in a generic blob.
   */
  readonly brandLogoUrl?: string;
  /** Fallback glyph drawn in the shell blob when no logo asset is supplied. */
  readonly brandMark?: string;
  /** Logo asset for the Host Center choice, in place of an initial letter. */
  readonly hostCenterIconUrl?: string;
  readonly takosumiActionLabel?: string;
  readonly takosumiActionDescription?: string;
  readonly manualActionLabel?: string;
  readonly manualActionDescription?: string;
  readonly manualBackLabel?: string;
  /** Lead sentence under the manual connect step header. */
  readonly manualStepLead?: string;
  readonly qrActionLabel?: string;
  readonly knownHostsLabel?: string;
  readonly knownHostsClearLabel?: string;
  readonly knownHostForgetLabel?: (host: MobileKnownHost) => string;
  readonly discoveredHeading: string;
  readonly homeFallbackTitle: string;
  readonly lockedSessionTitle?: string;
  readonly unlockSessionLabel?: string;
  readonly refreshLabel: string;
  readonly copyHostUrlLabel?: string;
  readonly copyHostUrlSuccessStatus?: string;
  readonly copyHostUrlFailedStatus?: string;
  readonly homeTitle: (home: Home | undefined) => string | undefined;
  readonly metricsLabel: string;
  readonly shortcutsLabel: string;
}

export interface MobileClientShellProps<Home> {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly loadHome: (session: MobileSession) => Promise<Home>;
  readonly registerPush?: (
    input: MobilePushRegistrationCallbackInput,
  ) => Promise<void>;
  readonly unregisterPush?: (
    input: MobilePushRegistrationCallbackInput,
  ) => Promise<void>;
  readonly handlePushNotification?: (
    input: MobilePushNotificationCallbackInput,
  ) => Promise<void> | void;
  readonly sessionUnlock?: MobileSessionUnlockOptions;
  readonly homeLabel: string;
  readonly copy: MobileShellCopy<Home>;
  readonly metrics: readonly MobileShellMetric<Home>[];
  readonly hostActions: readonly MobileShellHostAction<Home>[];
  readonly renderHomeExtra?: (
    context: MobileShellHomeExtraContext<Home>,
  ) => JSX.Element;
}

export function MobileClientShell<Home>(props: MobileClientShellProps<Home>) {
  const controller = createMobileClientController<Home>({
    adapter: props.adapter,
    nativeBridge: props.nativeBridge,
    loadHome: props.loadHome,
    registerPush: props.registerPush,
    unregisterPush: props.unregisterPush,
    handlePushNotification: async (input) => {
      await props.handlePushNotification?.(input);
      if (input.kind !== "tapped") return;
      const routePath = resolvePushNotificationPath(input);
      if (routePath) {
        await openMobileHostRoute(props.nativeBridge, input.session, routePath);
      }
    },
    sessionUnlock: props.sessionUnlock,
    homeLabel: props.homeLabel,
  });
  const [state, setState] = createSignal<MobileClientState<Home>>(
    controller.getState(),
  );
  const [hostCopyStatus, setHostCopyStatus] = createSignal<
    string | undefined
  >();
  const [password, setPassword] = createSignal("");
  const [setupMode, setSetupMode] = createSignal<"choices" | "manual">(
    "choices",
  );
  // Drives which way a step slides in, so going deeper and coming back read as
  // opposite moves instead of the same fade.
  const [stepDirection, setStepDirection] = createSignal<"forward" | "back">(
    "forward",
  );
  let inputRef: HTMLInputElement | undefined;
  let unsubscribe: (() => void) | undefined;

  onMount(() => {
    unsubscribe = controller.subscribe(setState);
    void controller.start();
  });

  onCleanup(() => {
    unsubscribe?.();
    controller.stop();
  });

  function openManualStep() {
    setStepDirection("forward");
    setSetupMode("manual");
    queueMicrotask(() => inputRef?.focus());
  }

  function closeManualStep() {
    setStepDirection("back");
    setSetupMode("choices");
  }

  async function selectAction(
    actionId: (typeof controller.actions)[number]["id"],
  ) {
    const result = await controller.selectAction(actionId);
    if (result.focusInput) inputRef?.focus();
  }

  async function startSignIn() {
    const result = await controller.startSignIn();
    if (result.focusInput) inputRef?.focus();
  }

  async function signInWithPassword() {
    const value = password();
    try {
      await controller.signInWithPassword(value);
    } finally {
      // Do not retain the host password in the WebView after an attempt.
      setPassword("");
    }
  }

  async function connectKnownHost(hostUrl: string) {
    await controller.connectKnownHost(hostUrl);
  }

  async function forgetKnownHost(hostUrl: string) {
    await controller.forgetKnownHost(hostUrl);
  }

  async function clearKnownHosts() {
    await controller.clearKnownHosts();
  }

  async function openHostAction(
    session: MobileSession,
    action: MobileShellHostAction<Home>,
  ) {
    const routePath = resolveHostActionPath(action, {
      session,
      home: state().home,
    });
    if (!routePath) return;
    if (action.nativeIntent === "call" && props.nativeBridge.requestCall) {
      await props.nativeBridge.requestCall({
        roomUrl: createMobileHostRouteUrl(session, routePath),
        title: action.label,
      });
      return;
    }
    await openMobileHostRoute(props.nativeBridge, session, routePath);
  }

  async function copyHostUrl(session: MobileSession) {
    try {
      await copyMobileText({
        text: session.hostUrl,
        label: `${props.adapter.appName} host URL`,
        writeClipboardText: props.nativeBridge.writeClipboardText,
      });
      setHostCopyStatus(
        props.copy.copyHostUrlSuccessStatus ?? "Host URL copied.",
      );
    } catch (error) {
      setHostCopyStatus(
        mobileErrorMessage(
          error,
          props.copy.copyHostUrlFailedStatus ?? "Host URL copy failed.",
        ),
      );
    }
  }

  const homeTitle = () =>
    props.copy.homeTitle(state().home) ?? props.copy.homeFallbackTitle;
  const hostCenterAction = () =>
    controller.actions.find((action) => action.id === "host");
  const qrAction = () =>
    controller.actions.find((action) => action.id === "qr");

  return (
    <main
      class="app-shell"
      data-product={props.adapter.product}
      style={{ "--accent": props.adapter.accentColor }}
    >
      <Show
        when={!state().session && !state().discovery && !state().lockedSession}
      >
        <section class="mobile-onboarding" data-step={setupMode()}>
          <Show when={setupMode() === "choices"}>
            <div class="onboarding-step" data-direction={stepDirection()}>
              <Show
                when={props.copy.brandLogoUrl}
                fallback={
                  <div class="onboarding-brand" aria-hidden="true">
                    <span>
                      {props.copy.brandMark ??
                        props.adapter.appName.slice(0, 1)}
                    </span>
                  </div>
                }
              >
                {(logoUrl) => (
                  <img
                    class="onboarding-brand-logo"
                    src={logoUrl()}
                    alt=""
                    aria-hidden="true"
                  />
                )}
              </Show>
              <div class="onboarding-copy">
                <p class="eyebrow">{props.copy.eyebrow ?? "Mobile client"}</p>
                <h1>{props.adapter.appName}</h1>
                <h2>{props.copy.onboardingTitle ?? "つながる場所を選ぼう"}</h2>
                <p class="summary">{props.copy.summary}</p>
              </div>
              <section class="setup-choices" aria-label="接続方法">
              <Show when={hostCenterAction()}>
                {(action) => (
                  <button
                    type="button"
                    class="setup-choice setup-choice-primary"
                    onClick={() => void selectAction(action().id)}
                  >
                    <Show
                      when={props.copy.hostCenterIconUrl}
                      fallback={
                        <span class="setup-choice-icon">
                          {(props.adapter.hostCenterLabel ?? "Takosumi").slice(
                            0,
                            1,
                          )}
                        </span>
                      }
                    >
                      {(iconUrl) => (
                        <img
                          class="setup-choice-icon setup-choice-icon-logo"
                          src={iconUrl()}
                          alt=""
                        />
                      )}
                    </Show>
                    <span class="setup-choice-copy">
                      <strong>
                        {props.copy.takosumiActionLabel ?? "Takosumiで始める"}
                      </strong>
                      <small>
                        {props.copy.takosumiActionDescription ??
                          "Takosumiで用意したサーバーに接続します"}
                      </small>
                    </span>
                    <span class="setup-choice-arrow">›</span>
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="setup-choice"
                onClick={() => openManualStep()}
              >
                <span class="setup-choice-icon setup-choice-icon-manual">
                  ⌁
                </span>
                <span class="setup-choice-copy">
                  <strong>
                    {props.copy.manualActionLabel ?? "サーバーを自分で入力"}
                  </strong>
                  <small>
                    {props.copy.manualActionDescription ??
                      "CloudflareやセルフホストのURLを使います"}
                  </small>
                </span>
                <span class="setup-choice-arrow">›</span>
              </button>
              </section>
            </div>
          </Show>

          <Show when={setupMode() === "manual"}>
            <div class="onboarding-step" data-direction={stepDirection()}>
              <header class="step-header">
                <button
                  type="button"
                  class="step-back"
                  aria-label={props.copy.manualBackLabel ?? "接続方法に戻る"}
                  onClick={() => closeManualStep()}
                >
                  <span aria-hidden="true">‹</span>
                </button>
                <h1>
                  {props.copy.manualActionLabel ?? "サーバーを自分で入力"}
                </h1>
              </header>
              <form
                class="connect-panel manual-connect-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  void controller.connect();
                }}
              >
                <p class="step-lead">
                  {props.copy.manualStepLead ??
                    "接続先のURLを入力してください。"}
                </p>
                <label for="connect-input">{props.copy.connectLabel}</label>
                <div class="connect-input-row">
                  <input
                    id="connect-input"
                    name="mobile-connect"
                    ref={inputRef}
                    inputMode="url"
                    autocapitalize="none"
                    autocomplete="url"
                    value={state().connectInput}
                    placeholder={props.adapter.urlPlaceholder}
                    onInput={(event) =>
                      controller.setConnectInput(event.currentTarget.value)
                    }
                  />
                  <Show
                    when={Boolean(
                      qrAction() && props.nativeBridge.scanConnectionPayload,
                    )}
                  >
                    <button
                      type="button"
                      class="scan-button"
                      aria-label={props.copy.qrActionLabel ?? "QRを読み取る"}
                      onClick={() => void selectAction("qr")}
                    >
                      <QrGlyph />
                    </button>
                  </Show>
                </div>
                <button type="submit" class="primary connect-submit">
                  {props.adapter.primaryActionLabel}
                </button>
                <p class="status" aria-live="polite">
                  {state().status}
                </p>
              </form>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={!state().session && state().knownHosts.length > 0}>
        <section
          class="known-hosts"
          aria-label={props.copy.knownHostsLabel ?? "Recent hosts"}
        >
          <div class="known-hosts-header">
            <h2>{props.copy.knownHostsLabel ?? "Recent hosts"}</h2>
            <button
              type="button"
              class="text-button"
              onClick={() => void clearKnownHosts()}
            >
              {props.copy.knownHostsClearLabel ?? "Clear"}
            </button>
          </div>
          <div class="known-host-list">
            <For each={state().knownHosts}>
              {(host) => (
                <div class="known-host-row">
                  <button
                    type="button"
                    class="known-host"
                    onClick={() => void connectKnownHost(host.hostUrl)}
                  >
                    <span>{host.label ?? host.hostUrl}</span>
                    <small>{formatKnownHostDate(host.lastSeenAt)}</small>
                  </button>
                  <button
                    type="button"
                    class="known-host-remove"
                    aria-label={
                      props.copy.knownHostForgetLabel?.(host) ??
                      `Remove ${host.label ?? host.hostUrl}`
                    }
                    onClick={() => void forgetKnownHost(host.hostUrl)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={!state().session && state().discovery}>
        {(current) => (
          <section class="result-panel">
            <h2>{props.copy.discoveredHeading}</h2>
            <dl>
              <div>
                <dt>Host</dt>
                <dd>{current().hostUrl}</dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd>{current().detectedProduct ?? props.adapter.product}</dd>
              </div>
              <Show when={state().connectPayload?.setupTicket}>
                <div>
                  <dt>Host Center handoff</dt>
                  <dd>
                    <span class="handoff-pill">Setup ticket received</span>
                  </dd>
                </div>
              </Show>
              <Show when={current().oidcIssuer}>
                {(issuer) => (
                  <div>
                    <dt>OIDC issuer</dt>
                    <dd>{issuer()}</dd>
                  </div>
                )}
              </Show>
            </dl>
            <Show
              when={
                current().authMethods?.oidc ?? Boolean(current().oidcIssuer)
              }
            >
              <button type="button" class="primary" onClick={startSignIn}>
                Sign in with OIDC
              </button>
            </Show>
            <Show when={current().authMethods?.password}>
              <form
                class="password-sign-in"
                onSubmit={(event) => {
                  event.preventDefault();
                  void signInWithPassword();
                }}
              >
                <label for="mobile-password">Password</label>
                <input
                  id="mobile-password"
                  type="password"
                  autocomplete="current-password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                />
                <button type="submit" class="secondary">
                  Sign in with password
                </button>
              </form>
            </Show>
          </section>
        )}
      </Show>

      <Show when={state().session ? undefined : state().lockedSession}>
        {(lockedSession) => (
          <section class="result-panel">
            <div class="panel-header">
              <div>
                <h2>{props.copy.lockedSessionTitle ?? "Session locked"}</h2>
                <p>{lockedSession().hostUrl}</p>
              </div>
              <button
                type="button"
                class="primary"
                disabled={state().unlockLoading}
                onClick={() => void controller.unlockSession()}
              >
                {props.copy.unlockSessionLabel ?? "Unlock"}
              </button>
            </div>
            <p class="status">{state().status}</p>
          </section>
        )}
      </Show>

      <Show when={state().session}>
        {(current) => (
          <section class="result-panel">
            <div class="panel-header">
              <div>
                <h2>{homeTitle()}</h2>
                <p>{current().hostUrl}</p>
              </div>
              <div class="panel-actions">
                <Show when={props.nativeBridge.writeClipboardText}>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={props.copy.copyHostUrlLabel ?? "Copy URL"}
                    onClick={() => void copyHostUrl(current())}
                  >
                    {props.copy.copyHostUrlLabel ?? "Copy URL"}
                  </button>
                </Show>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={props.copy.refreshLabel}
                  disabled={state().homeLoading}
                  onClick={() => void controller.refreshHome()}
                >
                  Refresh
                </button>
              </div>
            </div>
            <div class="metrics" aria-label={props.copy.metricsLabel}>
              <For each={props.metrics}>
                {(metric) => (
                  <div>
                    <span>{formatCount(metric.value(state().home))}</span>
                    <small>{metric.label}</small>
                  </div>
                )}
              </For>
            </div>
            <div class="quick-actions" aria-label={props.copy.shortcutsLabel}>
              <For each={props.hostActions}>
                {(action) => (
                  <button
                    type="button"
                    class="quick-action"
                    onClick={() => void openHostAction(current(), action)}
                  >
                    <span>{action.label}</span>
                    <small>{action.description}</small>
                  </button>
                )}
              </For>
            </div>
            {props.renderHomeExtra?.({
              home: state().home,
              session: current(),
              refreshHome: () => controller.refreshHome(current()),
              openHostRoute: (path) =>
                openMobileHostRoute(props.nativeBridge, current(), path),
              openExternalUrl: (url) => props.nativeBridge.openExternalUrl(url),
              writeClipboardText: props.nativeBridge.writeClipboardText,
            })}
            <dl>
              <div>
                <dt>Token type</dt>
                <dd>{current().tokenType}</dd>
              </div>
              <Show when={current().expiresAt}>
                {(expiresAt) => (
                  <div>
                    <dt>Expires</dt>
                    <dd>{expiresAt()}</dd>
                  </div>
                )}
              </Show>
            </dl>
            <p class="status">{state().homeStatus}</p>
            <Show when={hostCopyStatus()}>
              {(copyStatus) => <p class="status">{copyStatus()}</p>}
            </Show>
            <Show when={state().pushStatus}>
              {(pushStatus) => <p class="status">{pushStatus()}</p>}
            </Show>
            <button
              type="button"
              class="secondary"
              onClick={() => void controller.signOut()}
            >
              Sign out
            </button>
          </section>
        )}
      </Show>
    </main>
  );
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "-";
}

function formatKnownHostDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function resolveHostActionPath<Home>(
  action: MobileShellHostAction<Home>,
  context: MobileShellHostActionContext<Home>,
): string | undefined {
  return typeof action.path === "function" ? action.path(context) : action.path;
}

/** Scan affordance drawn as a QR reticle instead of the letters "QR". */
function QrGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
      <rect x="8" y="8" width="8" height="8" rx="1.4" fill="currentColor" />
    </svg>
  );
}
