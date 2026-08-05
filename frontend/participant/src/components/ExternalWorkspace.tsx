import type { ExternalWorkspaceConfig } from "@gdm/shared";

interface Props {
  config?: ExternalWorkspaceConfig;
}

/**
 * Provider-neutral extension point for a future collaborative workspace.
 *
 * No provider is configured by default, so selecting external mode currently
 * shows an honest placeholder. A later integration can attach a safe,
 * group-specific embed URL without changing the chat layout again.
 */
export default function ExternalWorkspace({ config }: Props) {
  const embedUrl = safeEmbedUrl(config?.embedUrl);
  const title = config?.title?.trim() || "External workspace";

  if (!embedUrl) {
    return (
      <section className="external-workspace-placeholder" aria-live="polite">
        <h3>External workspace</h3>
        <p>
          Iframe support is available, but no external workspace provider is
          configured yet. Please continue using the group chat.
        </p>
      </section>
    );
  }

  return (
    <section className="external-workspace">
      <h3>{title}</h3>
      <iframe
        src={embedUrl}
        title={title}
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}

function safeEmbedUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
