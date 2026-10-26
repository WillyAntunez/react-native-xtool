declare module "xcode" {
  export function project(file: string): { parseSync(): any; [key: string]: any };
}
