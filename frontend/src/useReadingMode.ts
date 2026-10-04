import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Keep the reader on the same slide as both columns reflow. */
export function useReadingMode(
  content: RefObject<HTMLDivElement | null>,
  documentId: string | null,
) {
  const [readingMode, setActive] = useState(false);
  const anchor = useRef<{
    element: HTMLElement;
    fraction: number;
    gap: number;
  } | null>(null);
  const setReadingMode = useCallback(
    (enabled: boolean) => {
      const scroller = content.current;
      if (scroller) {
        const top = scroller.getBoundingClientRect().top;
        const row = Array.from(
          scroller.querySelectorAll<HTMLElement>(".slide-row"),
        ).find((element) => element.getBoundingClientRect().bottom > top + 1);
        if (row) {
          const bounds = row.getBoundingClientRect();
          anchor.current = {
            element: row,
            fraction: Math.max(0, (top - bounds.top) / bounds.height),
            gap: Math.max(0, bounds.top - top),
          };
        }
      }
      setActive(enabled);
    },
    [content],
  );

  useLayoutEffect(() => {
    const scroller = content.current;
    const saved = anchor.current;
    if (scroller && saved?.element.isConnected) {
      const bounds = saved.element.getBoundingClientRect();
      const delta =
        bounds.top -
        scroller.getBoundingClientRect().top +
        saved.fraction * bounds.height -
        saved.gap;
      // Avoid the normal smooth scrolling while restoring the reading position.
      scroller.scrollTo({
        top: scroller.scrollTop + delta,
        behavior: "instant",
      });
    }
    anchor.current = null;
    document
      .getElementById(readingMode ? "exit-reading-mode" : "enter-reading-mode")
      ?.focus({ preventScroll: true });
  }, [readingMode, content]);

  useEffect(() => {
    anchor.current = null;
    setActive(false);
  }, [documentId]);

  return { readingMode, setReadingMode };
}
