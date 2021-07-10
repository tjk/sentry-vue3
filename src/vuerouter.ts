import { captureException } from '@sentry/browser';
import { Transaction, TransactionContext } from '@sentry/types';
import type { Route, Router } from 'vue-router';

export type VueRouterInstrumentation = <T extends Transaction>(
  startTransaction: (context: TransactionContext) => T | undefined,
  startTransactionOnPageLoad?: boolean,
  startTransactionOnLocationChange?: boolean,
) => void;

function getTransactionContext(route: Route) {
  return {
    name: route.name || route.path,
    tags: {
      "routing.instrumentation": "vue-router",
    },
    data: {
      params: route.params,
      query: route.query,
    },
  }
}

export function vueRouterInstrumentation(router: Router): VueRouterInstrumentation {
  return async (
    startTransaction: (context: TransactionContext) => Transaction | undefined,
    startTransactionOnPageLoad: boolean = true,
    startTransactionOnLocationChange: boolean = true,
  ) => {
    router.onError(err => captureException(err))
    router.beforeEach((to, _from, next) => {
      if (startTransactionOnLocationChange) {
        startTransaction({
          ...getTransactionContext(to),
          op: "navigation",
        })
      }
      next()
    })
    // XXX is delaying this transaction start bad?
    await router.isReady()
    if (startTransactionOnPageLoad) {
      startTransaction({
        ...getTransactionContext(router.currentRoute.value),
        op: "pageload",
      })
    }
  }
}
