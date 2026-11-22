classdef Seg3
    methods
        function r = viaGlobal(ets)
            e = ets(1);
            global e
            r = isj(e);
        end
        function r = viaEval(ets)
            e = ets(1);
            eval('e = 7;');
            r = isj(e);
        end
        function r = viaLoad(ets, f)
            e = ets(1);
            load(f);
            r = isj(e);
        end
        function r = control(ets)
            e = ets(1);
            r = isj(e);
        end
        function t = isj(e, varargin)
            t = true;
        end
    end
end
