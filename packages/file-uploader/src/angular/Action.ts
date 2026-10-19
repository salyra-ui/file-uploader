import {
  Directive,
  HostBinding,
  HostListener,
  inject,
  Input,
  booleanAttribute,
} from "@angular/core";
import { Root } from "./Root";
import { Item } from "./Items";
@Directive({ selector: "button[uploadAction]", standalone: true })
export class Action {
  @Input({ required: true }) uploadAction!:
    | "start"
    | "pause"
    | "resume"
    | "retry"
    | "cancel"
    | "reset"
    | "remove"
    | "forget";
  @Input() uploadItemId?: string;
  private root = inject(Root);
  private item = inject(Item, { optional: true });
  @Input({ alias: "disabled", transform: booleanAttribute }) nativeDisabled =
    false;
  @HostBinding("disabled") get disabled() {
    const state = this.root.controls();
    return this.nativeDisabled || state?.disabled || state?.readOnly || false;
  }
  @HostListener("click", ["$event"]) click(event: Event) {
    queueMicrotask(() => {
      if (event.defaultPrevented || this.disabled) return;
      const id = this.uploadItemId ?? this.item?.uploadItem;
      if (this.uploadAction === "start") this.root.store.start(id);
      else if (id) void this.root.store[this.uploadAction](id);
    });
  }
}
