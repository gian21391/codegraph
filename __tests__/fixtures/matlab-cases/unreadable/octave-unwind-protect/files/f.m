function f()
  unwind_protect
    stepOne();
  unwind_protect_cleanup
    stepTwo();
  end_unwind_protect
end
