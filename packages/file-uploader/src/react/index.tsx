"use client";

import { Root } from "./Root";
import { Input, Trigger, Dropzone } from "./Selection";
import {
  List,
  Item,
  Name,
  Metadata,
  Progress,
  Status,
  Output,
  Preview,
} from "./Items";
import { Action } from "./Action";
export const FileUploader = {
  Root,
  Input,
  Trigger,
  Dropzone,
  List,
  Item,
  Name,
  Metadata,
  Progress,
  Status,
  Output,
  Preview,
  Action,
};
export {
  Root,
  Input,
  Trigger,
  Dropzone,
  List,
  Item,
  Name,
  Metadata,
  Progress,
  Status,
  Output,
  Preview,
  Action,
};
export { useUploader, useUploadItem, useUploaderStore } from "./context";
export type { RootProps } from "./Root";
export type { ListProps } from "./Items";
export type { UploadAction } from "./Action";
export * from "../core";
