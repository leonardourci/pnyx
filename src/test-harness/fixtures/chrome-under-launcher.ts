import { test } from 'node:test'
import { assertChromeOffKeychain } from './fake-chrome.ts'

test(
  'a Chrome started under the test launcher stays off the Keychain',
  assertChromeOffKeychain,
)
