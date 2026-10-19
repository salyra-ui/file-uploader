import { Directive, Input, OnInit, OnDestroy, signal } from "@angular/core";
import {
  createUploader,
  type UploaderOptions,
  type UploaderStore,
} from "../core";
@Directive({
  selector: "[uploadRoot]",
  standalone: true,
  exportAs: "uploadRoot",
})
export class Root implements OnInit, OnDestroy {
  @Input("uploadRoot") options?: UploaderOptions;
  @Input() uploadStore?: UploaderStore;
  private owned = false;
  private instance?: UploaderStore;
  private stop?: () => void;
  readonly controls = signal({ disabled: false, readOnly: false });
  readonly inputs = new Set<HTMLInputElement>();
  readonly snapshot = signal<
    ReturnType<UploaderStore["getSnapshot"]> | undefined
  >(undefined);
  get store() {
    if (!this.instance) {
      if (!this.uploadStore && !this.options)
        throw new Error("uploadRoot requires options or uploadStore");
      this.instance = this.uploadStore ?? createUploader(this.options!);
      this.owned = !this.uploadStore;
    }
    return this.instance;
  }
  ngOnInit() {
    const store = this.store;
    this.snapshot.set(store.getSnapshot());
    const update = () => {
      const next = store.getSnapshot();
      this.snapshot.set(next);
      const previous = this.controls();
      if (
        previous.disabled !== next.disabled ||
        previous.readOnly !== next.readOnly
      )
        this.controls.set({ disabled: next.disabled, readOnly: next.readOnly });
    };
    update();
    this.stop = store.subscribe(update);
    if (typeof window !== "undefined") void store.restore();
  }
  ngOnDestroy() {
    this.stop?.();
    if (this.owned) this.instance?.destroy();
  }
}
