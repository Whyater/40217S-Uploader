<!-- markdownlint-disable MD013 -->

# Third-party notices

The compiled robot program published in this repository's Releases bundles
third-party code. Each component is listed below with its license, copyright
line, and source. This file does not change the license of those components.
The team's own code is covered by the LICENSE file.

The program was built with PROS kernel 4.2.2, LemLib 0.5.6, and LVGL 9.2.0
(the `liblvgl` 9.2.0 PROS template), using the Arm GNU Toolchain.

## LemLib

- License: MIT
- Copyright (c) 2024 Liam Teale and LemLib contributors
- Source: <https://github.com/LemLib/LemLib>

```text
MIT License

Copyright (c) 2024 Liam Teale and LemLib contributors

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
```

## {fmt}

LemLib includes and links the {fmt} formatting library.

- License: MIT, with an optional exception for embedded machine-executable object form
- Copyright (c) 2012 - present, Victor Zverovich and {fmt} contributors
- Source: <https://github.com/fmtlib/fmt>

```text
Copyright (c) 2012 - present, Victor Zverovich and {fmt} contributors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

## LVGL

Linked through the PROS `liblvgl` template.

- License: MIT
- Copyright (c) 2021 LVGL Kft
- Source: <https://github.com/lvgl/lvgl>

```text
MIT licence
Copyright (c) 2021 LVGL Kft

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

LVGL's source tree also contains these decoders, which appear in the compiled `liblvgl` library:

- LodePNG, zlib license, Copyright (c) 2005-2023 Lode Vandevenne. Source: <https://github.com/lvandeve/lodepng>
- TJpgDec, Copyright (C) 2021, ChaN. Its terms: free to use, modify, and redistribute, including in commercial products, with the copyright notice retained in source. Source: <https://elm-chan.org/fsw/tjpgd/00index.html>
- gifdec, by Christopher Lecram. Source: <https://github.com/lecram/gifdec>. See the author's repository for its terms.

## PROS kernel

- License: Mozilla Public License 2.0 (MPL-2.0)
- Copyright (c) 2017-2024, Purdue University ACM SIGBots (from the kernel's source file headers)
- The kernel's source code is available at <https://github.com/purduesigbots/pros>.
- Full license text: <https://github.com/purduesigbots/pros/blob/develop/LICENSE>

The PROS kernel depends on VEX's proprietary V5 SDK, which PROS distributes with VEX's permission. That SDK is under VEX's own terms and is not reproduced here.

### FreeRTOS kernel (inside PROS)

- License: MIT
- Copyright (C) 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
- Source: <https://github.com/purduesigbots/pros/tree/develop/src/rtos>

```text
Copyright (C) 2017 Amazon.com, Inc. or its affiliates.  All Rights Reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## newlib (C library and math library)

- License: BSD-style, with several copyright holders (for example Red Hat, Inc.). Each source file carries its own notice.
- Source and license notes: <https://sourceware.org/newlib/>

## GCC runtime libraries (libgcc, libstdc++)

- License: GNU GPL version 3 with the GCC Runtime Library Exception
- Source: <https://gcc.gnu.org/> (Arm GNU Toolchain, <https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads>)
- Exception text: <https://www.gnu.org/licenses/gcc-exception-3.1.html>

## PROS CLI (downloaded by the installer, not bundled)

`install.ps1` downloads the official, unmodified PROS CLI 3.5.6 for Windows from its GitHub release and checks its SHA-256 hash. It is not stored in this repository.

- License: Mozilla Public License 2.0 (MPL-2.0)
- Source: <https://github.com/purduesigbots/pros-cli>
- Full license text: <https://github.com/purduesigbots/pros-cli/blob/master/LICENSE>
