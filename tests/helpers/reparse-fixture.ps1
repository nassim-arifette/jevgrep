param([Parameter(Mandatory=$true)][string]$Target, [switch]$Remove)
$ErrorActionPreference = 'Stop'
# A test-only, non-Microsoft tag with a fixed GUID and no data/filter/target.
# CREATE_NEW prevents replacing an existing entry. OPEN_REPARSE_POINT permits
# removing the tag in finally without asking an absent filter to interpret it.
# https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-reparse_guid_data_buffer
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class JevGrepReparseFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
  public static int Set(string path, bool remove) {
    using (var file = CreateFileW(path, 0xC0000000, 0, IntPtr.Zero, remove ? 3u : 1u, 0x00200000, IntPtr.Zero)) {
      if (file.IsInvalid) return Marshal.GetLastWin32Error();
      var buffer = new byte[24];
      Array.Copy(BitConverter.GetBytes((uint)0x00000042), buffer, 4);
      Array.Copy(new Guid("4ddc6567-8f62-4f4c-bf55-6bd79a128c11").ToByteArray(), 0, buffer, 8, 16);
      uint returned;
      uint control = remove ? 0x000900ACu : 0x000900A4u;
      return DeviceIoControl(file, control, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
    }
  }
}
'@
[Console]::WriteLine([JevGrepReparseFixture]::Set($Target, $Remove.IsPresent))
