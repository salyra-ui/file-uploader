import {
  Directive,
  ElementRef,
  HostBinding,
  HostListener,
  inject,
  OnInit,
  OnDestroy,
  Input as AngularInput,
  booleanAttribute,
  Output,
  EventEmitter,
} from "@angular/core";
import { Root } from "./Root";
@Directive({ selector: "input[uploadInput]", standalone: true })
export class Input implements OnInit, OnDestroy {
  private root = inject(Root);
  private element =
    inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
  @HostBinding("type") type = "file";
  @AngularInput({ alias: "disabled", transform: booleanAttribute })
  nativeDisabled = false;
  @HostBinding("disabled") get disabled() {
    const state = this.root.controls();
    return this.nativeDisabled || state?.disabled || state?.readOnly || false;
  }
  ngOnInit() {
    this.root.inputs.add(this.element);
  }
  ngOnDestroy() {
    this.root.inputs.delete(this.element);
  }
  @HostListener("change", ["$event"]) changed(event: Event) {
    const files = Array.from(this.element.files ?? []);
    queueMicrotask(() => {
      if (event.defaultPrevented || this.disabled) return;
      void this.root.store.add(files);
      this.element.value = "";
    });
  }
}
@Directive({ selector: "button[uploadTrigger]", standalone: true })
export class Trigger {
  private root = inject(Root);
  @AngularInput({ alias: "disabled", transform: booleanAttribute })
  nativeDisabled = false;
  @HostBinding("disabled") get disabled() {
    const state = this.root.controls();
    return this.nativeDisabled || state?.disabled || state?.readOnly || false;
  }
  @HostListener("click", ["$event"]) clicked(event: Event) {
    queueMicrotask(() => {
      if (!event.defaultPrevented && !this.disabled)
        [...this.root.inputs].find((input) => !input.disabled)?.click();
    });
  }
}
@Directive({
  selector: "[uploadDropzone]",
  standalone: true,
  exportAs: "uploadDropzone",
})
export class Dropzone {
  private root = inject(Root);
  private element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  @Output() uploadBeforeDrop = new EventEmitter<DragEvent>();
  private blocked() {
    const state = this.root.controls();
    return state?.disabled || state?.readOnly;
  }
  @HostBinding("attr.aria-disabled") get disabled() {
    return this.blocked() || null;
  }
  @HostBinding("attr.data-dragging") dragging: string | null = null;
  @HostListener("dragover", ["$event"]) over(event: DragEvent) {
    if (!event.defaultPrevented && !this.blocked()) event.preventDefault();
  }
  @HostListener("dragenter", ["$event"]) enter(event: DragEvent) {
    if (!event.defaultPrevented && !this.blocked()) this.dragging = "true";
  }
  @HostListener("dragleave", ["$event"]) leave(event: DragEvent) {
    if (!this.element.contains(event.relatedTarget as Node | null))
      this.dragging = null;
  }
  @HostListener("drop", ["$event"]) drop(event: DragEvent) {
    this.dragging = null;
    this.uploadBeforeDrop.emit(event);
    if (event.defaultPrevented || this.blocked()) return;
    event.preventDefault();
    void this.root.store.add(Array.from(event.dataTransfer?.files ?? []));
  }
}
