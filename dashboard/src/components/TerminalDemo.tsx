import {
  AnimatedSpan,
  Terminal,
  TypingAnimation,
} from "@/components/ui/terminal"

export function TerminalDemo() {
  return (
    <Terminal>
      <TypingAnimation delay={500}>&gt; npm install -g @jrok/cli</TypingAnimation>
      
      <AnimatedSpan delay={2500} className="text-green-500">
        <span>✔ Installed @jrok/cli</span>
      </AnimatedSpan>

      <TypingAnimation delay={3500}>&gt; jrok --port 3000</TypingAnimation>

      <AnimatedSpan delay={5000} className="text-blue-500">
        <span>Tunnel started: https://pizza-7234986.jrok.koompi.cloud</span>
      </AnimatedSpan>
      
      <AnimatedSpan delay={5500} className="text-muted-foreground">
        <span>Forwarding http://localhost:3000 -&gt; https://pizza-7234986.jrok.koompi.cloud</span>
      </AnimatedSpan>
    </Terminal>
  )
}
