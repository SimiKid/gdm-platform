import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RankingBoard from "./RankingBoard";

const items = [
  { id: "compass", label: "Magnetic compass" },
  { id: "food", label: "Food concentrate" },
  { id: "map", label: "Stellar map" },
];

/** jsdom has no DataTransfer; a minimal stand-in carries the dragged id. */
function dataTransfer(initial = "") {
  let payload = initial;
  return {
    setData: (_type: string, value: string) => {
      payload = value;
    },
    getData: () => payload,
    effectAllowed: "",
  };
}

describe("RankingBoard", () => {
  it("adds, moves and removes items with the keyboard-accessible buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <RankingBoard items={items} ranked={[]} onChange={onChange} />,
    );

    expect(screen.getByText("(3 left)")).toBeInTheDocument();
    expect(screen.getByText(/Drag items here/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Food concentrate to the ranking" }));
    expect(onChange).toHaveBeenLastCalledWith(["food"]);

    rerender(<RankingBoard items={items} ranked={["food", "compass"]} onChange={onChange} />);
    const ranking = within(screen.getByRole("region", { name: /Your ranking/ }));
    expect(ranking.getByRole("button", { name: "Move Food concentrate up" })).toBeDisabled();
    expect(ranking.getByRole("button", { name: "Move Magnetic compass down" })).toBeDisabled();

    await user.click(ranking.getByRole("button", { name: "Move Food concentrate down" }));
    expect(onChange).toHaveBeenLastCalledWith(["compass", "food"]);

    await user.click(ranking.getByRole("button", { name: "Move Magnetic compass up" }));
    expect(onChange).toHaveBeenLastCalledWith(["compass", "food"]);

    await user.click(ranking.getByRole("button", { name: "Remove Food concentrate from the ranking" }));
    expect(onChange).toHaveBeenLastCalledWith(["compass"]);
  });

  it("drops a pool item before the hovered ranked item, anchored on that item", () => {
    const onChange = vi.fn();
    render(<RankingBoard items={items} ranked={["compass", "food"]} onChange={onChange} />);
    const dt = dataTransfer();

    fireEvent.dragStart(screen.getByText("Stellar map").closest("li")!, { dataTransfer: dt });
    const foodRow = screen.getByText("Food concentrate").closest("li")!;
    fireEvent.dragOver(foodRow, { dataTransfer: dt });
    expect(foodRow).toHaveClass("drop-before");
    fireEvent.drop(foodRow, { dataTransfer: dt });

    expect(onChange).toHaveBeenCalledWith(["compass", "map", "food"]);
    expect(foodRow).not.toHaveClass("drop-before");
  });

  it("moves a ranked item downward without landing one slot low", () => {
    const onChange = vi.fn();
    render(
      <RankingBoard items={items} ranked={["compass", "food", "map"]} onChange={onChange} />,
    );
    const dt = dataTransfer();

    fireEvent.dragStart(screen.getByText("Magnetic compass").closest("li")!, { dataTransfer: dt });
    const mapRow = screen.getByText("Stellar map").closest("li")!;
    fireEvent.dragOver(mapRow, { dataTransfer: dt });
    fireEvent.drop(mapRow, { dataTransfer: dt });

    expect(onChange).toHaveBeenCalledWith(["food", "compass", "map"]);
  });

  it("appends when dropped on the ranking background and ignores a self-drop", () => {
    const onChange = vi.fn();
    render(<RankingBoard items={items} ranked={["compass"]} onChange={onChange} />);
    const ranking = screen.getByRole("region", { name: /Your ranking/ });

    fireEvent.dragOver(ranking, { dataTransfer: dataTransfer() });
    fireEvent.drop(ranking, { dataTransfer: dataTransfer("map") });
    expect(onChange).toHaveBeenCalledWith(["compass", "map"]);

    onChange.mockClear();
    const compassRow = screen.getByText("Magnetic compass").closest("li")!;
    const dt = dataTransfer();
    fireEvent.dragStart(compassRow, { dataTransfer: dt });
    fireEvent.dragOver(compassRow, { dataTransfer: dt });
    fireEvent.drop(compassRow, { dataTransfer: dt });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns a ranked item to the pool by dropping it there", () => {
    const onChange = vi.fn();
    render(<RankingBoard items={items} ranked={["compass", "food"]} onChange={onChange} />);
    const pool = screen.getByRole("region", { name: "Items still to rank" });
    const dt = dataTransfer();

    fireEvent.dragStart(screen.getByText("Food concentrate").closest("li")!, { dataTransfer: dt });
    fireEvent.dragOver(pool, { dataTransfer: dt });
    fireEvent.drop(pool, { dataTransfer: dt });

    expect(onChange).toHaveBeenCalledWith(["compass"]);
  });

  it("falls back to the drag state when the browser drops the transfer payload", () => {
    const onChange = vi.fn();
    render(<RankingBoard items={items} ranked={[]} onChange={onChange} />);
    const row = screen.getByText("Magnetic compass").closest("li")!;

    fireEvent.dragStart(row, { dataTransfer: dataTransfer() });
    expect(row).toHaveClass("dragging");
    fireEvent.drop(screen.getByRole("region", { name: /Your ranking/ }), {
      dataTransfer: { getData: () => "" },
    });
    expect(onChange).toHaveBeenCalledWith(["compass"]);

    fireEvent.dragEnd(row);
    expect(row).not.toHaveClass("dragging");
  });

  it("with poolBelow hides the pool once everything is ranked", () => {
    const { rerender } = render(
      <RankingBoard items={items} ranked={["compass"]} onChange={vi.fn()} poolBelow />,
    );
    expect(screen.getByRole("region", { name: "Items still to rank" })).toBeInTheDocument();
    rerender(
      <RankingBoard items={items} ranked={["compass", "food", "map"]} onChange={vi.fn()} poolBelow />,
    );
    expect(screen.queryByRole("region", { name: "Items still to rank" })).toBeNull();

    // Without poolBelow, the empty pool stays visible with its confirmation.
    rerender(
      <RankingBoard items={items} ranked={["compass", "food", "map"]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("All items ranked ✓")).toBeInTheDocument();
  });
});
