declare module "*.svelte" {
  const component: import("svelte").Component<any>;
  export default component;
}
declare module "*.astro" {
  const component: any;
  export default component;
}
