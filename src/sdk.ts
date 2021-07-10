import { App, ComponentPublicInstance, RendererElement, warn } from 'vue'
import {
  BrowserOptions,
  getCurrentHub,
  init as browserInit,
} from '@sentry/browser'
import { Span, Transaction } from '@sentry/types'
import { basename, logger, timestampWithMs } from '@sentry/utils'

// match package.json... lazy
const VERSION = '6.2.3-alpha.0'

// XXX not exported but can't write to vm.$options... so use these on instance._
// https://v3.vuejs.org/guide/composition-api-lifecycle-hooks
const enum LifecycleHook {
  BEFORE_CREATE = 'bc',
  CREATED = 'c',
  BEFORE_MOUNT = 'bm',
  MOUNTED = 'm',
  BEFORE_UPDATE = 'bu',
  UPDATED = 'u',
  BEFORE_UNMOUNT = 'bum',
  UNMOUNTED = 'um',
  DEACTIVATED = 'da',
  ACTIVATED = 'a',
}

// https://github.com/Microsoft/TypeScript/issues/25760#issuecomment-406158222
type AllKeyOf<T> = T extends never ? never : keyof T
type Omit<T, K> = { [P in Exclude<keyof T, K>]: T[P] }
type Optional<T, K> = { [P in Extract<keyof T, K>]?: T[P] }
type WithOptional<T, K extends AllKeyOf<T>> = T extends never
  ? never
  : Omit<T, K> & Optional<T, K>

export interface VueOptions extends BrowserOptions {
  /** Vue app to be used inside the integration */
  app: App<RendererElement>

  /**
   * When set to `false`, Sentry will suppress reporting of all props data
   * from your Vue components for privacy concerns.
   */
  attachProps: boolean

  /**
   * When set to `true`, original Vue's `logError` will be called as well.
   * https://github.com/vuejs/vue/blob/c2b1cfe9ccd08835f2d99f6ce60f67b4de55187f/src/core/util/error.js#L38-L48
   */
  logErrors: boolean

  /** {@link TracingOptions} */
  tracingOptions: TracingOptions
}

/** Optional metadata attached to Sentry Event */
interface Metadata {
  [key: string]: any
  componentName?: string
  propsData?: { [key: string]: any }
  lifecycleHook?: string
}

// Mappings from operation to corresponding lifecycle hook.
const HOOKS: { [key in Operation]: LifecycleHook[] } = {
  activate: [LifecycleHook.ACTIVATED, LifecycleHook.DEACTIVATED],
  create: [LifecycleHook.BEFORE_CREATE, LifecycleHook.CREATED],
  unmount: [LifecycleHook.BEFORE_UNMOUNT, LifecycleHook.UNMOUNTED],
  mount: [LifecycleHook.BEFORE_MOUNT, LifecycleHook.MOUNTED],
  update: [LifecycleHook.BEFORE_UPDATE, LifecycleHook.UPDATED],
}

type Operation = 'activate' | 'create' | 'unmount' | 'mount' | 'update'

function toUpper(_, c) {
  return c ? c.toUpperCase() : ''
}

function cached(fn) {
  const cache = Object.create(null)
  return function cachedFn(str) {
    const hit = cache[str]
    return hit || (cache[str] = fn(str))
  }
}

const classifyRE = /(?:^|[-_/])(\w)/g
const classify = cached((str: string) => {
  return str && str.replace(classifyRE, toUpper)
})

/** Vue specific configuration for Tracing Integration  */
interface TracingOptions {
  /**
   * Decides whether to track components by hooking into its lifecycle methods.
   * Can be either set to `boolean` to enable/disable tracking for all of them.
   * Or to an array of specific component names (case-sensitive).
   */
  trackComponents: boolean | string[]
  /** How long to wait until the tracked root activity is marked as finished and sent of to Sentry */
  timeout: number
  /**
   * List of hooks to keep track of during component lifecycle.
   * Based on https://v3.vuejs.org/guide/composition-api-lifecycle-hooks
   */
  hooks: Operation[]
}

/** Grabs active transaction off scope, if any */
export function getActiveTransaction(): Transaction | undefined {
  return getCurrentHub()
    .getScope()
    ?.getTransaction()
}

/** JSDoc */
class VueHelper {
  private _installCache: { [uid: number]: boolean } = {}
  private _nameCache: { [uid: number]: string } = {}
  private _rootSpan?: Span
  private _rootSpanTimer?: ReturnType<typeof setTimeout>
  private _options: VueOptions

  /**
   * @inheritDoc
   */
  public constructor(options: VueOptions) {
    this._options = options
  }

  /**
   * Attaches the error handler and starts tracing
   */
  public setup(): void {
    this._attachErrorHandler()

    if (
      'tracesSampleRate' in this._options ||
      'tracesSampler' in this._options
    ) {
      this._startTracing()
    }
  }

  private _saveComponentName(instance, name) {
    this._nameCache[instance.uid] = name
    return name
  }

  private _getComponentTypeName(options) {
    const name =
      options.name || options._componentTag || this._nameCache[options.uid] // TODO check .uid
    if (name) {
      return name
    }
    const file = options.__file // injected by vue-loader
    if (file) {
      return classify(basename(file, '.vue'))
    }
  }

  // https://github.com/vuejs/devtools/blob/main/packages/app-backend-vue3/src/components/util.ts#L29
  private _getComponentName(instance: any) {
    const name = this._getComponentTypeName(instance.type || {})
    if (name) return name
    if (instance.root === instance) return 'Root'
    for (const key in instance.parent?.type?.components) {
      if (instance.parent.type.components[key] === instance.type)
        return this._saveComponentName(instance, key)
    }
    for (const key in instance.appContext?.components) {
      if (instance.appContext.components[key] === instance.type)
        return this._saveComponentName(instance, key)
    }
    return 'Anonymous Component'
  }

  private readonly _injectHook = (
    instance: any,
    hook: LifecycleHook,
    fn: (execNumber: number) => void
  ): void => {
    const hooks = instance[hook] || (instance[hook] = [])
    let execNumber = 0
    // https://github.com/vuejs/vue-next/blob/master/packages/runtime-core/src/apiLifecycle.ts
    const doHook = () => {
      if (!instance.isUnmounted) {
        // TODO use callWithAsyncErrorHandling?
        fn(execNumber++)
      }
    }
    // XXX later hooks can be prepended which we don't really want
    hooks.unshift(doHook)
  }

  /** Keep it as attribute function, to keep correct `this` binding inside the hooks callbacks  */
  // eslint-disable-next-line @typescript-eslint/typedef
  private readonly _applyTracingHooks = (vm: ComponentPublicInstance): void => {
    const instance = (vm as any)._ || vm
    // Don't attach twice, just in case
    if (this._installCache[instance.uid]) {
      return
    }
    this._installCache[instance.uid] = true

    const name = this._getComponentName(instance)
    const spans: { [key: string]: Span } = {}

    // Render hook starts after once event is emitted,
    // but it ends before the second event of the same type.
    //
    // Because of this, we start measuring inside the first event,
    // but finish it before it triggers, to skip the event emitter timing itself.
    const rootHandler = (execNumber: number): void => {
      const now = timestampWithMs()

      // On the first handler call (before), it'll be undefined, as we add it in the future.
      // However, on the second call (after), it'll be already in place.
      if (this._rootSpan) {
        this._finishRootSpan(now)
      } else {
        if (execNumber === 1) {
          // Create an activity on the first event call.
          // There'll be no second call, as rootSpan will be in place,
          // thus new event handler won't be attached.
          const activeTransaction = getActiveTransaction()
          if (activeTransaction) {
            this._rootSpan = activeTransaction.startChild({
              description: 'Application Render',
              op: 'Vue',
            })
          }
        }
      }
    }

    const childHandler = (operation: Operation, execNumber: number): void => {
      // Skip components that we don't want to track to minimize the noise and give a more granular control to the user
      const shouldTrack = Array.isArray(
        this._options.tracingOptions.trackComponents
      )
        ? this._options.tracingOptions.trackComponents.indexOf(name) > -1
        : this._options.tracingOptions.trackComponents

      const childOf = this._rootSpan || getActiveTransaction()

      if (!childOf || !shouldTrack) {
        return
      }

      const now = timestampWithMs()
      const span = spans[operation]
      // On the first handler call (before), it'll be undefined, as we add it in the future.
      // However, on the second call (after), it'll be already in place.
      if (span) {
        span.finish()
        this._finishRootSpan(now)
      } else {
        if (execNumber === 1) {
          if (childOf) {
            spans[operation] = childOf.startChild({
              description: `Vue <${name}>`,
              op: operation,
            })
          }
        }
      }
    }

    // Each component has it's own scope, so all activities are only related to one of them
    this._options.tracingOptions.hooks.forEach(operation => {
      // Retrieve corresponding hooks from Vue lifecycle.
      // eg. mount => ['beforeMount', 'mounted']
      const internalHooks = HOOKS[operation]

      if (!internalHooks) {
        logger.warn(`Unknown hook: ${operation}`)
        return
      }

      internalHooks.forEach(internalHook => {
        const handler =
          instance.root === instance
            ? rootHandler.bind(this)
            : childHandler.bind(this, operation)
        this._injectHook(instance, internalHook, handler)
      })
    })
  }

  /** Finish top-level span and activity with a debounce configured using `timeout` option */
  private _finishRootSpan(timestamp: number): void {
    if (this._rootSpanTimer) {
      clearTimeout(this._rootSpanTimer)
    }

    this._rootSpanTimer = setTimeout(() => {
      // We should always finish the span, only should pop activity if using @sentry/apm
      if (this._rootSpan) {
        this._rootSpan.finish(timestamp)
        this._rootSpan = undefined
      }
    }, this._options.tracingOptions.timeout)
  }

  /** Inject configured tracing hooks into Vue's component lifecycles */
  private _startTracing(): void {
    const applyTracingHooks = this._applyTracingHooks
    // TODO this message is being printed... figure out why
    const appliedTracingHooks = setTimeout(() => {
      logger.warn(
        "Didn't apply tracing hooks, make sure you call Sentry.init before initialzing Vue!"
      )
    }, 500)
    this._options.app.mixin({
      beforeCreate(this: ComponentPublicInstance): void {
        clearTimeout(appliedTracingHooks)
        applyTracingHooks(this)
      },
    })
  }

  /** Inject Sentry's handler into owns Vue's error handler  */
  private _attachErrorHandler(): void {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const currentErrorHandler = this._options.app.config.errorHandler

    this._options.app.config.errorHandler = (
      err: unknown,
      vm: ComponentPublicInstance | null,
      info?: string
    ): void => {
      const metadata: Metadata = {}

      if (vm) {
        try {
          const instance = (vm as any)._ || vm
          metadata.componentName = this._getComponentName(instance)

          if (this._options.attachProps) {
            metadata.propsData = vm.$props
          }
        } catch (_oO) {
          logger.warn('Unable to extract metadata from Vue component.')
        }
      }

      if (info) {
        metadata.lifecycleHook = info
      }

      // Capture exception in the next event loop,
      // to make sure that all breadcrumbs are recorded in time.
      setTimeout(() => {
        getCurrentHub().withScope(scope => {
          scope.setContext('vue', metadata)
          getCurrentHub().captureException(err)
        })
      })

      if (typeof currentErrorHandler === 'function') {
        currentErrorHandler.call(this._options.app, err, vm, info)
      }

      if (this._options.logErrors) {
        warn(`Error in ${info}: '${err && (err as any).toString()}'`, vm)
        // eslint-disable-next-line no-console
        console.error(err)
      }
    }
  }
}

/**
 * Inits the Vue SDK
 */
export function init(
  options: WithOptional<
    VueOptions,
    'attachProps' | 'logErrors' | 'tracingOptions'
  >
): void {
  const finalOptions = {
    attachProps: true,
    logErrors: false,
    ...options,
    tracingOptions: {
      hooks: ['activate', 'mount', 'update'],
      timeout: 2000,
      trackComponents: false,
      ...options.tracingOptions,
    },
  } as VueOptions

  finalOptions._metadata = finalOptions._metadata || {}
  finalOptions._metadata.sdk = {
    name: 'sentry.javascript.vue3',
    packages: [
      {
        name: 'npm@tjk/sentry-vue3',
        version: VERSION,
      },
    ],
    version: VERSION,
  }

  browserInit(finalOptions)
  if (!finalOptions.app) {
    logger.warn('No Vue app instance was provided.')
    logger.warn('We will only capture global unhandled errors.')
  } else {
    const vueHelper = new VueHelper(finalOptions)
    vueHelper.setup()
  }
}
