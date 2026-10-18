export const meta = {
  name: 'child',
  description: 'A child workflow: one agent, its args echoed back.',
}

const reply = await agent(`Reply with exactly the text ${args.word} and nothing else.`, { label: 'child-agent' })
return { reply, args }
