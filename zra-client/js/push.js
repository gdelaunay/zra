// Abonnement Web Push : `sw.js` gère déjà `push` et `notificationclick`.
//
// Un navigateur n'a qu'un abonnement push par service worker, lié à une clé
// VAPID : on s'abonne au premier poste en ligne qui en annonce une (le poste
// d'origine, servi par le daemon, vient en premier). Changer de poste cible
// réabonne. `settings.notifications` porte le choix de l'utilisateur.

import { settings, update } from './settings.js'
import * as store from './store.js'
import { tr } from './i18n.js'

export const pushSupported = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
  typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window

/** Clé VAPID base64url → Uint8Array, pour `pushManager.subscribe`. */
function urlKey(b64url) {
  const raw = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function sameKey(buffer, key) {
  if (!buffer) return false
  const a = new Uint8Array(buffer)
  return a.length === key.length && a.every((b, i) => b === key[i])
}

/** Demande la permission puis s'abonne. @returns {Promise<{ok:boolean, reason?:string}>} */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: tr`notifications non supportées par ce navigateur` }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: tr`notifications refusées dans le navigateur` }
  update({ notifications: true })
  await syncPush()
  return { ok: true }
}

export async function disablePush() {
  update({ notifications: false })
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  for (const m of store.state.machines.values()) {
    if (m.status === 'online') m.link.send({ type: 'push_unsubscribe', endpoint: sub.endpoint })
  }
  await sub.unsubscribe()
}

let syncing = false

/**
 * (Ré)abonnement au poste cible. Appelé à l'activation et quand un poste
 * passe en ligne ; muet tant que l'utilisateur n'a pas activé les
 * notifications ou que le navigateur ne les a pas accordées.
 */
export async function syncPush() {
  if (syncing || !settings.notifications || !pushSupported() || Notification.permission !== 'granted') return
  const machine = [...store.state.machines.values()].find((m) => m.status === 'online' && m.info?.pushKey)
  if (!machine) return
  syncing = true
  try {
    const reg = await navigator.serviceWorker.ready
    const key = urlKey(machine.info.pushKey)
    let sub = await reg.pushManager.getSubscription()
    // Autre clé VAPID (poste changé, daemon réinstallé) : il faut réabonner.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe()
      sub = null
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    machine.link.send({ type: 'push_subscribe', machineId: machine.id, subscription: sub.toJSON() })
  } catch (err) {
    console.debug('[push] abonnement impossible', err)
  } finally {
    syncing = false
  }
}
