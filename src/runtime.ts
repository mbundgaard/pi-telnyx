import { ConfigStore, configuredMapping, publicMapping, type ConfigureInput, type Mapping, type PublicMapping } from './config.js';
import { listenRelay, type RelayListener, type RelayPeer, type RelayRequest } from './relay-transport.js';
import { startTunnel, type Tunnel, type TunnelStarter, type TunnelStatus } from './tunnel.js';
import { Diagnostics, type DiagnosticEvent } from './diagnostics.js';
import { listenTexml, type TexmlListener } from './texml.js';

export interface Host {
  sessionId(): string;
  onConnect(peer: RelayPeer): boolean;
  onRequest(peer: RelayPeer, request: RelayRequest): void;
  onDisconnect(peer: RelayPeer): void;
}
export interface RuntimeOptions { projectDirectory: string; store?: ConfigStore; listen?: typeof listenRelay; startTunnel?: TunnelStarter }
export interface RuntimeStatus {
  sessionId: string;
  configured: boolean;
  mapping?: PublicMapping;
  listener: 'stopped' | 'starting' | 'ready' | 'failed';
  tunnel: TunnelStatus | { state: 'not-configured' | 'disabled' };
  error?: string;
  diagnostics?: ReturnType<Diagnostics['status']>;
  texml?: { state: 'ready' | 'stopped' | 'disabled'; port: number };
}
export interface ConfigureResult { token: string; status: RuntimeStatus }
/** Lifecycle methods serialize cleanup and fence delivery immediately at invocation. */
export class Runtime {
  readonly store: ConfigStore;
  private generation = 0;
  private operations = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private initialId = '';
  private mapping?: Mapping;
  private listener?: RelayListener;
  private tunnel?: Tunnel;
  private listenerState: RuntimeStatus['listener'] = 'stopped';
  private failure?: string;
  private diagnostics?: Diagnostics;
  private texml?: TexmlListener;
  diagnostic(event: DiagnosticEvent): void { this.diagnostics?.write({ ...event, sessionId: this.initialId }); }
  constructor(readonly host: Host, readonly options: RuntimeOptions) {
    this.store = options.store ?? new ConfigStore(options.projectDirectory);
  }
  status(): RuntimeStatus {
    const current = this.host.sessionId() === this.initialId;
    return { sessionId: this.host.sessionId(), configured: current && this.mapping !== undefined,
      ...(current && this.mapping ? { mapping: publicMapping(this.mapping) } : {}),
      listener: current ? (this.listenerState === 'ready' && this.listener?.isReady?.() === false ? 'failed' : this.listenerState) : 'stopped',
      tunnel: current && this.tunnel ? this.tunnel.status()
        : current && this.mapping?.tunnel?.enabled ? { state: 'stopped', publicReachabilityVerified: false }
        : { state: current && this.mapping?.tunnel ? 'disabled' : 'not-configured' },
      ...(current && this.failure ? { error: this.failure } : {}),
      ...(current && this.diagnostics ? { diagnostics: this.diagnostics.status() } : {}),
      ...(current && this.mapping?.texml ? { texml: { state: this.texml?.isReady() ? 'ready' as const : this.mapping.texml.enabled ? 'stopped' as const : 'disabled' as const, port: this.mapping.texml.port } } : {}) };
  }
  private operation<T>(work: (id: string, guard: () => void) => Promise<T>): Promise<T> {
    this.operations++;
    const generation = ++this.generation, id = this.host.sessionId();
    const guard = () => { if (generation !== this.generation || id !== this.host.sessionId()) throw new Error('Telnyx lifecycle changed'); };
    const result = this.chain.catch(() => {}).then(async () => {
      await this.cleanup(); guard();
      this.initialId = id; this.failure = undefined; this.mapping = undefined;
      try { return await work(id, guard); }
      catch (error) {
        this.diagnostic({ event: 'runtime.failure', reason: 'operation-failed' });
        const listenerFailed = this.listenerState === 'failed';
        await this.cleanup();
        if (generation === this.generation) {
          this.failure = 'Telnyx operation failed';
          if (listenerFailed) this.listenerState = 'failed';
        }
        // Only deliberately public messages escape; OS errors and token-bearing objects never do.
        throw new Error(error instanceof Error && ['Relay port is already in use', 'No mapping for current session', 'Telnyx lifecycle changed'].includes(error.message) ? error.message : 'Telnyx operation failed');
      }
    });
    const settled = result.finally(() => { this.operations--; });
    this.chain = settled;
    return settled;
  }
  private async cleanup(): Promise<void> {
    const listener = this.listener, tunnel = this.tunnel, texml = this.texml;
    this.listenerState = 'stopped';
    // Retain ownership on uncertain cleanup so later lifecycle calls cannot start replacements.
    await Promise.all([listener?.close(), tunnel?.close(), texml?.close()]);
    this.listener = undefined; this.tunnel = undefined; this.texml = undefined;
    this.diagnostic({ event: 'runtime.stopped' }); this.diagnostics?.close(); this.diagnostics = undefined;
  }
  private async activate(id: string, guard: () => void): Promise<void> {
    if (!this.mapping?.enabled) return;
    const generation = this.generation, mapping = this.mapping;
    this.listenerState = 'starting';
    this.diagnostics = new Diagnostics(this.store.directory, mapping.diagnostics ?? { enabled: false }, [mapping.token]);
    this.diagnostic({ event: 'runtime.starting' });
    try {
      const listener = await (this.options.listen ?? listenRelay)({ host: mapping.host, port: mapping.port, token: mapping.token,
        isCurrent: () => generation === this.generation && id === this.host.sessionId(),
        onConnect: peer => { guard(); return this.host.onConnect(peer); },
        onRequest: (peer, request) => { guard(); this.host.onRequest(peer, request); },
        onDisconnect: peer => this.host.onDisconnect(peer), diagnostic: event => this.diagnostic(event) });
      this.listener = listener; guard(); this.listenerState = 'ready';
      this.diagnostic({ event: 'runtime.listener-ready' });
      if (mapping.texml?.enabled) {
        this.texml = await listenTexml({ host: mapping.host, config: mapping.texml,
          isCurrent: () => generation === this.generation && id === this.host.sessionId(), diagnostic: event => this.diagnostic(event) });
        guard(); this.diagnostic({ event: 'runtime.texml-ready' });
      }
      if (mapping.tunnel?.enabled) {
        const tunnel = await (this.options.startTunnel ?? startTunnel)(mapping.tunnel);
        this.tunnel = tunnel; guard();
        this.diagnostic({ event: 'runtime.tunnel-started' });
      }
    } catch (error) { this.listenerState = 'failed'; throw error; }
  }
  start(): Promise<RuntimeStatus> {
    return this.operation(async (id, guard) => {
      const config = await this.store.read(); guard(); this.mapping = config.sessions[id];
      await this.activate(id, guard); return this.status();
    });
  }
  close(): Promise<void> {
    ++this.generation; this.operations++;
    const result = this.chain.catch(() => {}).then(async () => { await this.cleanup(); }).finally(() => { this.operations--; });
    this.chain = result; return result;
  }
  /** Explicit credential retrieval never starts/stops resources or rotates the credential. */
  async token(): Promise<{ sessionId: string; token: string }> {
    const generation = this.generation, id = this.host.sessionId();
    if (id !== this.initialId || this.operations !== 0) throw new Error('Telnyx session is not ready');
    const config = await this.store.read();
    if (generation !== this.generation || id !== this.host.sessionId()) throw new Error('Telnyx lifecycle changed');
    const mapping = config.sessions[id];
    if (!mapping) throw new Error('No mapping for current session');
    return { sessionId: id, token: mapping.token };
  }
  /** Configuration always disables the mapping; explicitly enable afterward. Token return is intentional. */
  configure(input: ConfigureInput): Promise<ConfigureResult> {
    return this.operation(async (id, guard) => {
      const config = await this.store.update(c => { c.sessions[id] = configuredMapping(input, c.sessions[id]); }, guard);
      guard(); this.mapping = config.sessions[id]!;
      return { token: this.mapping.token, status: this.status() };
    });
  }
  isRunning(): boolean {
    return this.operations === 0 && this.initialId === this.host.sessionId() && this.mapping?.enabled === true && this.status().listener === 'ready'
      && (!this.mapping.texml?.enabled || this.texml?.isReady() === true)
      && (!this.mapping.tunnel?.enabled || ['spawned', 'connection-ready'].includes(this.tunnel?.status().state ?? ''));
  }
  enable(): Promise<RuntimeStatus> { return this.isRunning() ? Promise.resolve(this.status()) : this.setEnabled(true); }
  disable(): Promise<RuntimeStatus> { return this.setEnabled(false); }
  private setEnabled(enabled: boolean): Promise<RuntimeStatus> {
    return this.operation(async (id, guard) => {
      const previous = await this.store.read(); guard();
      if (!previous.sessions[id]) { if (enabled) throw new Error('No mapping for current session'); return this.status(); }
      const config = await this.store.update(c => {
        if (!c.sessions[id]) throw new Error('No mapping for current session');
        c.sessions[id]!.enabled = enabled;
      }, guard);
      guard(); this.mapping = config.sessions[id];
      await this.activate(id, guard); return this.status();
    });
  }
}
