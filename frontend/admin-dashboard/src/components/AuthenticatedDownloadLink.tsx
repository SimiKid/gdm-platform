import { useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { apiFetch, exportPath, exportUrl } from "../api";

interface Props
  extends Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    "href" | "download" | "onClick"
  > {
  path: string;
  query?: string;
  filename: string;
}

/** Download a protected export without placing its bearer token in the URL. */
export default function AuthenticatedDownloadLink({
  path,
  query = "",
  filename,
  children,
  ...anchorProps
}: Props) {
  const [error, setError] = useState(false);

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setError(false);
    try {
      const response = await apiFetch(exportPath(path, query));
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
    }
  }

  return (
    <>
      <a
        {...anchorProps}
        href={exportUrl(path, query)}
        download={filename}
        onClick={(event) => void download(event)}
      >
        {children}
      </a>
      {error && (
        <span className="bad" role="alert">
          Download failed
        </span>
      )}
    </>
  );
}
