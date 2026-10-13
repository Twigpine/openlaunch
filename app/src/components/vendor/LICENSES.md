# Vendored component notices

## Openlaunch navigation shell

`../navigation-shell.tsx` is an original Openlaunch implementation, covered by the repository's license. It replaces the previously vendored Aceternity navbar and retains the composition API, floating-header behavior, and Openlaunch accessibility fixes. It does not include the Aceternity registry implementation.

## Coss UI

`tabs.tsx` and `toggle-group.tsx` adapt the Coss UI registry recipes: [tabs](https://coss.com/ui/r/tabs.json), [toggle group](https://coss.com/ui/r/toggle-group.json), and [toggle](https://coss.com/ui/r/toggle.json). These recipes come from the upstream [`apps/ui/registry/` tree](https://github.com/cosscom/coss/tree/main/apps/ui/registry).

The upstream [licensing guide](https://github.com/cosscom/coss/blob/main/LICENSING.md) explicitly licenses `apps/ui/` under MIT, as an exception to the monorepo's default AGPL license. The [`apps/ui/` README](https://github.com/cosscom/coss/blob/main/apps/ui/README.md) also identifies its license as MIT. This note records those upstream licensing sources without assigning an unprovided copyright holder. Openlaunch-specific token and styling changes are documented in each component.

## Magic UI

`animated-theme-toggler.tsx` is adapted from the [Magic UI component](https://magicui.design/docs/components/animated-theme-toggler). The upstream [license](https://github.com/magicuidesign/magicui/blob/main/LICENSE.md) is reproduced below. Openlaunch-specific changes are noted in the source.

These are adapted from Magic UI registry items under the same license, each with its local changes noted at the top of the file: `border-beam.tsx` ([border-beam](https://magicui.design/r/border-beam.json)), `marquee.tsx` ([marquee](https://magicui.design/r/marquee.json)), `flickering-grid.tsx` ([flickering-grid](https://magicui.design/r/flickering-grid.json)), `animated-shiny-text.tsx` ([animated-shiny-text](https://magicui.design/r/animated-shiny-text.json)), `magic-card.tsx` ([magic-card](https://magicui.design/r/magic-card.json)), `shine-border.tsx` ([shine-border](https://magicui.design/r/shine-border.json)) and `animated-list.tsx` ([animated-list](https://magicui.design/r/animated-list.json)).

MIT License

Copyright (c) Magic UI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
