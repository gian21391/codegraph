function gui()
t = timer('TimerFcn', @onTick);
    function onTick(src, evt)
        disp(1);
    end
end
