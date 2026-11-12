import { scenarioGroup } from '#test-harness/harness.ts'
import { testChromeOffKeychain } from './fake-chrome.ts'

scenarioGroup()
testChromeOffKeychain({ where: 'beside the scenario harness' })
