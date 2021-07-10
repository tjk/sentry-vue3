# @tjk/sentry-vue3

EXPERIMENTAL: Use at own risk!

https://github.com/getsentry/sentry-javascript/issues/2925

Based off of @sentry/vue + code from https://github.com/vuejs/devtools

To install:

```bash
yarn add @tjk/sentry-vue3
```

To use:

```js
import { createApp } from 'vue'
import { createRouter } from 'vue-router'
import * as Sentry, { vueRouterInstrumentation } from '@tjk/sentry-vue3'
import RootComponent from './root.vue'

const app = new createApp(RootComponent)
const router = createRouter()

Sentry.init({
  dsn: SENTRY_DSN,
  release: SENTRY_RELEASE,
  environment: NODE_ENV,
  app,
  tracingOptions: {
    trackComponents: true,
  },
  debug: NODE_ENV === "development",
  logErrors: NODE_ENV === "development",
  integrations: [
    new Integrations.BrowserTracing({
      routingInstrumentation: vueRouterInstrumentation(router),
    }),
  ],
  tracesSampleRate: 1.0,
})
```
