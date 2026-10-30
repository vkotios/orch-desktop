//! Process-tree ownership for the bundled host. Windows job object with
//! KILL_ON_JOB_CLOSE; other platforms are unqualified and report that explicitly.

use tokio::process::Child;

#[cfg(windows)]
mod imp {
    use super::Child;
    use std::ffi::c_void;
    use std::io::Error;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::ptr::null;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owned, non-inheritable job handle. `OwnedHandle` closes it on drop, which
    /// kills every process still in the job.
    pub struct Job(OwnedHandle);

    fn fail(call: &str) -> String {
        format!("{call} failed: {}", Error::last_os_error())
    }

    impl Job {
        pub fn new() -> Result<Job, String> {
            // SAFETY: null attributes/name create an anonymous, non-inheritable job.
            let raw = unsafe { CreateJobObjectW(null(), null()) };
            if raw.is_null() {
                return Err(fail("CreateJobObjectW"));
            }
            // SAFETY: `raw` is a freshly created handle that nothing else owns.
            let job = Job(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) });
            // SAFETY: the limit structure is plain data; all-zero is a valid initial value.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: pointer/size describe `info`, which outlives the call.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(fail("SetInformationJobObject"));
            }
            Ok(job)
        }

        pub fn assign_child(&self, child: &Child) -> Result<(), String> {
            let process = child.raw_handle().ok_or("host process handle is already released")?;
            // SAFETY: both handles are valid for the duration of the call; ownership is not transferred.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
                return Err(fail("AssignProcessToJobObject"));
            }
            Ok(())
        }

        pub fn terminate(&self) -> Result<(), String> {
            // SAFETY: the job handle is valid while `self` lives.
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                return Err(fail("TerminateJobObject"));
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Child;

    pub struct Job;

    const UNSUPPORTED: &str = "unsupported host platform: owned host runtime is qualified for Windows only";

    impl Job {
        pub fn new() -> Result<Job, String> {
            Err(UNSUPPORTED.to_string())
        }
        pub fn assign_child(&self, _child: &Child) -> Result<(), String> {
            Err(UNSUPPORTED.to_string())
        }
        pub fn terminate(&self) -> Result<(), String> {
            Err(UNSUPPORTED.to_string())
        }
    }
}

pub use imp::Job;
