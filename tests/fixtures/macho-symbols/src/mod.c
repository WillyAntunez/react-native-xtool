/* Mod.framework: two strong imports from Core and one weak import, which dyld tolerates when missing. */
int core_old(void);
int core_new(void);
int core_weak(void) __attribute__((weak_import));

int mod_entry(void) {
  return core_old() + core_new() + (core_weak ? core_weak() : 0);
}
