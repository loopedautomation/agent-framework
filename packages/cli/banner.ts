// The first-boot banner: shown once per agent, on the run where it names
// itself. A little something for the devs.

const ART = String.raw`
   ██╗      ██████╗  ██████╗ ██████╗ ███████╗██████╗      █████╗ ███████╗
   ██║     ██╔═══██╗██╔═══██╗██╔══██╗██╔════╝██╔══██╗    ██╔══██╗██╔════╝
   ██║     ██║   ██║██║   ██║██████╔╝█████╗  ██║  ██║    ███████║█████╗
   ██║     ██║   ██║██║   ██║██╔═══╝ ██╔══╝  ██║  ██║    ██╔══██║██╔══╝
   ███████╗╚██████╔╝╚██████╔╝██║     ███████╗██████╔╝    ██║  ██║██║
   ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚══════╝╚═════╝     ╚═╝  ╚═╝╚═╝`;

const LOOP_GRADIENT = ["#22d3ee", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc"];

/** Print the birth banner: gradient art, then the agent's chosen name. */
export function printBirthBanner(nickname: string, name: string) {
  const lines = ART.split("\n").slice(1);
  for (let i = 0; i < lines.length; i++) {
    console.log(`%c${lines[i]}`, `color: ${LOOP_GRADIENT[i % LOOP_GRADIENT.length]}`);
  }
  console.log(
    `\n   %cone job · one file · it’s hired%c                      looped.sh\n`,
    "color: gray; font-style: italic",
    "color: gray",
  );
  console.log(
    `   ✦ first boot — %c${nickname}%c has chosen a name: %c${name}%c\n`,
    "color: gray",
    "",
    "color: #22d3ee; font-weight: bold",
    "",
  );
}
