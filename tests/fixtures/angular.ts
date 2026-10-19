import "@angular/compiler";
import { Component, provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { FileUploader } from "../../packages/file-uploader/src/angular";
import { createUploader } from "../../packages/file-uploader/src/core";
import { chunkedTransport } from "../../packages/file-uploader/src/transport/chunked";
@Component({
  selector: "app-uploader-test",
  standalone: true,
  imports: [
    FileUploader.Root,
    FileUploader.Input,
    FileUploader.Action,
    FileUploader.List,
    FileUploader.Item,
    FileUploader.Name,
    FileUploader.Status,
    FileUploader.Progress,
  ],
  template: `<section uploadRoot [uploadStore]="store">
    <input uploadInput aria-label="Select files" multiple /><button
      type="button"
      uploadAction="start"
    >
      Upload</button
    ><button
      type="button"
      uploadAction="start"
      (click)="$event.preventDefault()"
    >
      Blocked upload</button
    ><button type="button" uploadAction="start" [disabled]="true">
      Disabled upload</button
    ><button type="button" (click)="disable()">Disable root</button>
    <div uploadList #list="uploadList">
      @for (id of list.ids(); track id) {
        <article [uploadItem]="id" #item="uploadItem" class="custom-row">
          <span uploadName></span><span uploadStatus></span>
          <button type="button" uploadAction="cancel">Cancel</button
          ><button type="button" uploadAction="retry">Retry</button>
          <div uploadProgress aria-label="Upload progress">
            {{ item.value()?.progress }}%
          </div>
        </article>
      }
    </div>
  </section>`,
})
class App {
  readonly store = createUploader({
    transport: chunkedTransport({ baseURL: "/uploads" }),
    chunkSize: 262144,
  });
  disable() {
    this.store.setOptions({ disabled: true });
  }
  ngOnDestroy() {
    this.store.destroy();
  }
}
bootstrapApplication(App, {
  providers: [provideZonelessChangeDetection()],
}).catch((error) => {
  document.body.textContent = String(error);
  throw error;
});
