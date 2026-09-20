import {describe, expect, it} from 'vitest'
import ProfileShow from '#commands/profile/show.js'

describe('ProfileShow', () => {
  it('takes a required profile name', () => {
    expect(ProfileShow.args.name.required).toBe(true)
    expect(ProfileShow.strict).toBe(true)
  })

  it('defaults to the composed profile, with --raw as the special case', () => {
    expect(ProfileShow.flags.raw.default).toBe(false)
  })
})
