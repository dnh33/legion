/** Shared fixtures for the connector gateway tests that need a real Engine: a signed-in GitHub client over the fake GitHub, and the module on top. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { GitHubClient } from '../src/core/connectors/github/client.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { TokenStore } from '../src/core/connectors/store.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { FAKE_CLIENT_ID, FakeGitHub } from './connectors-fake-github.js';
import { tempDir } from './tmp-cleanup.js';

export async function signedInGitHub(): Promise<{ fake: FakeGitHub; client: GitHubClient; keys: ConnectorKeyring }> {
  const fake = await new FakeGitHub().start();
  const keys = new ConnectorKeyring();
  keys.install(randomBytes(32));
  const store = new TokenStore(join(tempDir('legion-cr-'), 'connectors'), keys);
  const client = new GitHubClient({ tokens: store, fetchFn: fake.fetchFn(), clientId: FAKE_CLIENT_ID, sleep: async () => undefined });
  await (await client.startDeviceFlow()).poll();
  fake.requests.length = 0;
  return { fake, client, keys };
}

/** The connectors module over a store that is looked up late (the engine rig builds its own store after the module). */
export function lateModule(storeOf: () => { getAgent(id: string): unknown; getTask(id: string): unknown }, gh: { client: GitHubClient; keys: ConnectorKeyring }) {
  const deps = { store: { getAgent: (id: string) => storeOf().getAgent(id), getTask: (id: string) => storeOf().getTask(id) } } as unknown as ModuleDeps;
  return createConnectorsModule(deps, { keys: gh.keys, client: () => gh.client });
}
