import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

/**
 * One throwaway Synapse for the whole integration run. SQLite-backed and
 * rate-limit-free so tests are fast; open registration matches the dev
 * homeserver in infra/synapse/homeserver.yaml.
 */
const HOMESERVER_YAML = `
server_name: "test"
pid_file: /data/homeserver.pid
report_stats: false

listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: true
    resources:
      - names: [client]
        compress: false

database:
  name: sqlite3
  args:
    database: /data/homeserver.db

log_config: "/data/log.config"
media_store_path: /data/media_store
signing_key_path: "/data/test.signing.key"
trusted_key_servers: []
suppress_key_server_warning: true

enable_registration: true
enable_registration_without_verification: true
encryption_enabled_by_default_for_room_type: "off"

# No rate limits — tests register users and send messages in bursts.
rc_message: { per_second: 1000, burst_count: 1000 }
rc_registration: { per_second: 1000, burst_count: 1000 }
rc_login:
  address: { per_second: 1000, burst_count: 1000 }
  account: { per_second: 1000, burst_count: 1000 }
  failed_attempts: { per_second: 1000, burst_count: 1000 }
rc_joins:
  local: { per_second: 1000, burst_count: 1000 }
  remote: { per_second: 1000, burst_count: 1000 }
`;

const LOG_CONFIG = `
version: 1
formatters:
  precise:
    format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
root:
  level: WARNING
  handlers: [console]
disable_existing_loggers: false
`;

export default async function setup(project: TestProject) {
  const container = await new GenericContainer("matrixdotorg/synapse:latest")
    .withCopyContentToContainer([
      { content: HOMESERVER_YAML, target: "/data/homeserver.yaml" },
      { content: LOG_CONFIG, target: "/data/log.config" },
    ])
    // Generate the signing key first; the image's /start.py generate mode
    // would overwrite our config instead.
    .withEntrypoint(["/bin/sh"])
    .withCommand([
      "-c",
      "python -m synapse.app.homeserver --config-path /data/homeserver.yaml --generate-keys && " +
        "exec python -m synapse.app.homeserver --config-path /data/homeserver.yaml",
    ])
    .withExposedPorts(8008)
    .withWaitStrategy(Wait.forHttp("/_matrix/client/versions", 8008))
    .withStartupTimeout(150_000)
    .start();

  project.provide(
    "synapseUrl",
    `http://${container.getHost()}:${container.getMappedPort(8008)}`,
  );

  return async () => {
    await container.stop();
  };
}
