import CopyCommand from './copy-command';
import Logo from './logo';

const REPO = 'https://github.com/parthh01/sphinx';
const NPM = 'https://www.npmjs.com/package/sphinx-understand';
const QUOTE = 'https://x.com/yacineMTB/status/2018886083120153046?s=20';

const steps = [
  ['You push.', 'Or your agent does. Git pauses on the branches you protect.'],
  ['Sphinx asks.', 'A reviewer that never saw your chat reads the diff and asks what the change does when things go wrong.'],
  ['You answer.', 'Get it wrong and you learn why, then try again, usually with a new scenario. Get it right and the push continues.'],
];

export default function Home() {
  return (
    <div className="page">
      <header className="top">
        <a className="wordmark" href="#"><Logo />sphinx</a>
        <nav>
          <a href="#start">Install</a>
          <a href={REPO}>GitHub</a>
        </nav>
      </header>

      <main>
        <section className="hero">
          <ul className="chips"><li>Free</li><li><a href={REPO}>FOSS</a></li></ul>
          <blockquote>
            <p>“You can outsource your thinking,<br /> but not your <em>understanding</em>.”</p>
          </blockquote>
          <p className="attribution">— <a href={QUOTE}>Sun Tzu</a></p>
          <p className="lede">
            Sphinx is a Git hook for agent-assisted development. Before your agent’s code ships, it asks you a
            question about what that code actually does.
          </p>
          <CopyCommand command="npm install -g sphinx-understand" />
          <p className="tokens">Built to run on minimal tokens, from your existing coding agent, OpenRouter, or any OpenAI-compatible endpoint.</p>
        </section>

        <section className="riddle" aria-label="Example checkpoint">
          <div className="line cmd"><span className="sigil">$</span> git push origin main</div>
          <div className="line dim">sphinx · understanding check for main</div>
          <div className="line dim">11 files changed · <span className="add">+5,012</span> <span className="del">−3,147</span></div>

          <div className="exchange">
            <p className="speaker">Sphinx</p>
            <p className="question">
              Your webhook handler now saves the event ID <em>before</em> calling <code>charge()</code>. Stripe times
              out and sends the same event again. What happens on the retry?
            </p>

            <p className="speaker you">You</p>
            <p className="answer">It runs twice, so the customer is charged twice.</p>

            <p className="speaker">Sphinx</p>
            <p className="feedback">
              Not quite. The retry finds the saved ID and returns 200 without charging. But that ID is stored before the
              charge succeeds. If <code>charge()</code> fails, what does the next retry do?
            </p>

            <p className="speaker you">You</p>
            <p className="answer">It skips the charge, so the customer is never billed.</p>
          </div>

          <div className="line ok"><span className="sigil">✓</span> Understood. Pushing to origin/main.</div>
          <p className="caption">An illustrative exchange. Real questions come from your diff.</p>
        </section>

        <section className="how">
          <ol>
            {steps.map(([title, body], i) => (
              <li key={title}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="demo" aria-label="Demo">
          <figure>
            <img src="/demo.gif" width="960" height="576" alt="A git push waits while the Sphinx questionnaire asks what the change does, the answer passes, and the push continues." />
            <figcaption>The real questionnaire: a push waits, you answer, Git continues.</figcaption>
          </figure>
        </section>

        <section className="facts">
          <p>
            Works with <strong>Codex, Claude Code, Cursor, OpenCode,</strong> and <strong>Pi</strong>, or plain Git.
            Your answers never reach the coding agent,
            and <code>.env</code> files and keys are never opened. In a hurry? <code>sphinx yolo</code> lets pushes
            through, and every skip is logged.
          </p>
        </section>

        <section className="start" id="start">
          <h2>Start in a minute.</h2>
          <pre><code><span className="c"># Node 22.19+ · macOS, Linux, or WSL</span>{'\n'}npm install -g sphinx-understand{'\n'}sphinx install{'\n\n'}<span className="c"># then push as usual</span>{'\n'}git push</code></pre>
          <p className="more">
            <code>sphinx install</code> connects Git and your coding agents and asks which model should review.{' '}
            <a href={`${REPO}#readme`}>Read the docs</a> for everything else.
          </p>
        </section>
      </main>

      <footer className="bottom">
        <span>sphinx · MIT licensed</span>
        <span><a href={REPO}>GitHub</a><a href={NPM}>npm</a></span>
      </footer>
    </div>
  );
}
