import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExternalWorkspace from "./ExternalWorkspace";

describe("ExternalWorkspace", () => {
  it("shows a clear placeholder while no provider is configured", () => {
    render(<ExternalWorkspace />);

    expect(screen.getByText("External workspace")).toBeInTheDocument();
    expect(screen.getByText(/no external workspace provider is configured/i)).toBeInTheDocument();
    expect(screen.queryByTitle("External workspace")).not.toBeInTheDocument();
  });

  it("embeds a future provider URL in a sandboxed iframe", () => {
    render(
      <ExternalWorkspace
        config={{
          title: "Shared notes",
          embedUrl: "https://pads.example.test/p/group-1",
        }}
      />,
    );

    const frame = screen.getByTitle("Shared notes");
    expect(frame).toHaveAttribute(
      "src",
      "https://pads.example.test/p/group-1",
    );
    expect(frame).toHaveAttribute("sandbox");
  });
});
