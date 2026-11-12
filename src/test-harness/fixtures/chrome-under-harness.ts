import { test } from 'node:test'
import { scenarioGroup } from '#test-harness/harness.ts'
import { assertChromeOffKeychain } from './fake-chrome.ts'

scenarioGroup()

test(
  'a Chrome started beside the scenario harness stays off the Keychain',
  assertChromeOffKeychain,
)
