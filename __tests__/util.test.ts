import {toErrorMessage} from '../src/util'

describe('toErrorMessage', () => {
  it('extracts message from Error objects', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('converts string errors to string', () => {
    expect(toErrorMessage('something broke')).toBe('something broke')
  })

  it('handles null', () => {
    expect(toErrorMessage(null)).toBe('Unknown error')
  })

  it('handles undefined', () => {
    expect(toErrorMessage(undefined)).toBe('Unknown error')
  })

  it('handles objects without message property', () => {
    expect(toErrorMessage({code: 404})).toBe('Unknown error')
  })

  it('handles objects with message property', () => {
    expect(toErrorMessage({message: 'not found'})).toBe('not found')
  })

  it('handles number errors', () => {
    expect(toErrorMessage(42)).toBe('Unknown error')
  })
})
