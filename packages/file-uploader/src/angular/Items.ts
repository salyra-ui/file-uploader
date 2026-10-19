import {
  Directive,
  Input,
  OnInit,
  OnDestroy,
  HostBinding,
  inject,
  signal,
  ElementRef,
} from "@angular/core";
import type { UploadItem } from "../core";
import { Root } from "./Root";
@Directive({
  selector: "[uploadList]",
  standalone: true,
  exportAs: "uploadList",
})
export class List implements OnInit, OnDestroy {
  private root = inject(Root);
  private stop?: () => void;
  readonly ids = signal<string[]>([]);
  ngOnInit() {
    const update = () => {
      const next = this.root.store.getSnapshot().items.map((item) => item.id);
      if (next.join("|") !== this.ids().join("|")) this.ids.set(next);
    };
    update();
    this.stop = this.root.store.subscribe(update);
  }
  ngOnDestroy() {
    this.stop?.();
  }
}
@Directive({
  selector: "[uploadItem]",
  standalone: true,
  exportAs: "uploadItem",
})
export class Item implements OnInit, OnDestroy {
  @Input({ required: true }) uploadItem!: string;
  private root = inject(Root);
  private stop?: () => void;
  readonly value = signal<UploadItem | undefined>(undefined);
  @HostBinding("attr.data-state") get state() {
    return this.value()?.status;
  }
  ngOnInit() {
    const update = () =>
      this.value.set(this.root.store.getItem(this.uploadItem));
    update();
    this.stop = this.root.store.subscribeItem(this.uploadItem, update);
  }
  ngOnDestroy() {
    this.stop?.();
  }
}
@Directive({ selector: "[uploadName]", standalone: true })
export class Name {
  private item = inject(Item);
  @HostBinding("textContent") get name() {
    return this.item.value()?.metadata.name;
  }
}
@Directive({ selector: "[uploadStatus]", standalone: true })
export class Status {
  private item = inject(Item);
  @Input() uploadStatus: Partial<Record<UploadItem["status"], string>> = {};
  @HostBinding("textContent") get label() {
    const state = this.item.value()?.status;
    return state && (this.uploadStatus[state] ?? state);
  }
}
@Directive({ selector: "[uploadMetadata]", standalone: true })
export class Metadata {
  private item = inject(Item);
  @Input({ required: true }) uploadMetadata!: (item: UploadItem) => string;
  @HostBinding("textContent") get label() {
    const item = this.item.value();
    return item && this.uploadMetadata(item);
  }
}
@Directive({
  selector: "[uploadProgress]",
  standalone: true,
  exportAs: "uploadProgress",
})
export class Progress {
  private item = inject(Item);
  @HostBinding("attr.role") role = "progressbar";
  @HostBinding("attr.aria-valuemin") min = 0;
  @HostBinding("attr.aria-valuemax") max = 100;
  @HostBinding("attr.data-state") get state() {
    return this.item.value()?.status;
  }
  @HostBinding("attr.data-indeterminate") get indeterminate() {
    return this.item.value()?.progress === null ? "" : null;
  }
  @HostBinding("attr.aria-valuenow") get value() {
    return this.item.value()?.progress;
  }
}
@Directive({
  selector: "[uploadPreview]",
  standalone: true,
  exportAs: "uploadPreview",
})
export class Preview implements OnDestroy {
  private item = inject(Item);
  private file?: File;
  private current?: string;
  get url() {
    const file = this.item.value()?.file;
    if (file !== this.file) {
      if (this.current) URL.revokeObjectURL(this.current);
      this.file = file;
      this.current =
        typeof window !== "undefined" && file
          ? URL.createObjectURL(file)
          : undefined;
    }
    return this.current;
  }
  ngOnDestroy() {
    if (this.current) URL.revokeObjectURL(this.current);
  }
}
@Directive({
  selector: "[uploadOutput]",
  standalone: true,
  exportAs: "uploadOutput",
})
export class Output {
  private root = inject(Root);
  readonly snapshot = this.root.snapshot;
}
