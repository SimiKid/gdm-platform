import {
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";
import { apiFetch, apiUrl } from "../api";

interface Props
  extends Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    "href" | "download" | "onClick"
  > {
  path: string;
  filename: string;
}

/** Download a protected export without placing its bearer token in the URL. */
export default function AuthenticatedDownloadLink({
  path,
  filename,
  children,
  ...anchorProps
}: Props) {
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadInFlight = useRef(false);

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    setDownloading(true);
    setError(false);
    try {
      const response = await apiFetch(path);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch {
      setError(true);
    } finally {
      downloadInFlight.current = false;
      setDownloading(false);
    }
  }

  return (
    <>
      <a
        {...anchorProps}
        href={apiUrl(path)}
        download={filename}
        aria-disabled={downloading}
        aria-busy={downloading}
        onClick={(event) => void download(event)}
      >
        {downloading ? "Preparing download…" : children}
      </a>
      {error && (
        <span className="bad" role="alert">
          Download failed
        </span>
      )}
    </>
  );
}
