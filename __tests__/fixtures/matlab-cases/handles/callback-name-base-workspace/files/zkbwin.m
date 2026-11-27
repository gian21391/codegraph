function zkbwin()
zkbwinhelp();
end
function zkbwinhelp()
evalin('caller', 'h = @zkbwinloc;');
evalin('caller', 'g = str2func(''zkbwinloc2'');');
evalin('base', 'h = @zkbwinloc3;');
evalin('caller', 'zkbwinloc4(1);');
end
function zkbwinloc(varargin)
end
function zkbwinloc2(varargin)
end
function zkbwinloc3(varargin)
end
function zkbwinloc4(varargin)
end
