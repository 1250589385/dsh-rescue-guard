export function mountBundledPwsh(ctx, shells) {
  ctx.inject(['loader'], loaderCtx => {
    const loader = loaderCtx.get('loader')
    const unhook = loaderCtx.on('internal/config', function (_raw, next) {
      const config = next()
      if (!matches(this.entry)) return config
      return { ...config, pwshPath: shells.pwsh.file }
    }, { global: true, prepend: true })
    loaderCtx.effect(() => () => unhook())
  })
}
