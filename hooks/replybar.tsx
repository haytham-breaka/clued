// The reply bar, floating on the top edge of the prompt (no band, no [-]).
// It draws `▎↩ Claude  first line…  #4  ✕` and posts { op: 'cancel' } when ✕ is clicked.
import type { ClientModule } from 'claude-code'

type Props = { who: string; text: string; thread: string }

const ReplyBar: ClientModule<Props> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState(true)
    surface.onPointer(e => {
      // ✕ sits in the last three columns.
      if (e.type === 'up' && e.x >= surface.columns - 3) surface.post({ op: 'cancel' })
    })
  }
  return (
    <Box flexDirection="row" gap={1} width="100%">
      <Text color="cyan">▎↩</Text>
      <Text color="cyan" bold>{props.who}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor wrap="truncate-end">{props.text}</Text>
      </Box>
      {props.thread ? <Text color="cyan" dimColor>{props.thread}</Text> : <Text> </Text>}
      <Text bold> ✕ </Text>
    </Box>
  )
}

export default ReplyBar
