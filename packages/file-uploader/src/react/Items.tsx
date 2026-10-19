import {
  forwardRef,
  useEffect,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
  type ElementType,
} from "react";
import type { UploadItem, UploaderSnapshot } from "../core";
import {
  ItemContext,
  useUploadItem,
  useUploader,
  useUploaderContext,
} from "./context";
export interface ListProps extends Omit<
  HTMLAttributes<HTMLUListElement>,
  "children"
> {
  as?: ElementType;
  children(ids: string[]): ReactNode;
}
export const List = forwardRef<HTMLUListElement, ListProps>(function List(
  { children, as: Component = "ul", ...props },
  ref,
) {
  const { store } = useUploaderContext();
  const ids = useSyncExternalStore(
    store.subscribe,
    () => JSON.stringify(store.getSnapshot().items.map((item) => item.id)),
    () => JSON.stringify(store.getSnapshot().items.map((item) => item.id)),
  );
  return (
    <Component {...props} ref={ref}>
      {children(JSON.parse(ids))}
    </Component>
  );
});
export const Item = forwardRef<
  HTMLLIElement,
  HTMLAttributes<HTMLLIElement> & { id: string; as?: ElementType }
>(function Item({ id, as: Component = "li", ...props }, ref) {
  const item = useUploadItem(id);
  if (!item) return null;
  return (
    <ItemContext.Provider value={id}>
      <Component
        {...props}
        ref={ref}
        data-state={item.status}
        data-upload-id={id}
      />
    </ItemContext.Provider>
  );
});
export function Name(props: HTMLAttributes<HTMLSpanElement>) {
  const item = useUploadItem();
  return <span {...props}>{props.children ?? item?.metadata.name}</span>;
}
export function Metadata({
  format,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  format?: (item: UploadItem) => ReactNode;
  children?: ReactNode | ((item: UploadItem) => ReactNode);
}) {
  const item = useUploadItem();
  return (
    <span {...props}>
      {item &&
        (typeof children === "function"
          ? children(item)
          : (children ?? format?.(item)))}
    </span>
  );
}
export function Status({
  labels,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  labels?: Partial<Record<UploadItem["status"], ReactNode>>;
}) {
  const item = useUploadItem();
  return (
    <span {...props} data-state={item?.status}>
      {props.children ?? (item && (labels?.[item.status] ?? item.status))}
    </span>
  );
}
export function Progress({
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode | ((item: UploadItem) => ReactNode);
}) {
  const item = useUploadItem();
  if (!item) return null;
  return (
    <div
      {...props}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={item.progress ?? undefined}
      data-state={item.status}
      data-indeterminate={item.progress === null || undefined}
    >
      {typeof children === "function" ? children(item) : children}
    </div>
  );
}
export function Output({
  children,
}: {
  children(snapshot: UploaderSnapshot): ReactNode;
}) {
  return <>{children(useUploader())}</>;
}
/** The renderer owns the markup. URLs are created on mount and revoked when the file changes or unmounts. */
export function Preview({
  children,
}: {
  children(value: { item: UploadItem; url?: string }): ReactNode;
}) {
  const item = useUploadItem(),
    [url, setURL] = useState<string>();
  useEffect(() => {
    if (!item?.file) {
      setURL(undefined);
      return;
    }
    const next = URL.createObjectURL(item.file);
    setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [item?.file]);
  return <>{item && children({ item, url })}</>;
}
