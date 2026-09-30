import { Nav } from './components/Nav.js';
import { Hero } from './components/Hero.js';
import { Demo } from './components/Demo.js';
import { Idea } from './components/Idea.js';
import { HowItWorks } from './components/HowItWorks.js';
import { Capabilities } from './components/Capabilities.js';
import { Trust } from './components/Trust.js';
import { DesktopStates } from './components/DesktopStates.js';
import { Download } from './components/Download.js';
import { Privacy } from './components/Privacy.js';
import { Footer } from './components/Footer.js';

export function App(): React.JSX.Element {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Demo />
        <Idea />
        <HowItWorks />
        <Capabilities />
        <Trust />
        <DesktopStates />
        <Download />
        <Privacy />
      </main>
      <Footer />
    </>
  );
}
